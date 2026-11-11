package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const defaultUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"

type config struct {
	port          string
	wait          time.Duration
	healTimeout   time.Duration
	poll          time.Duration
	stableTicks   int
	userAgent     string
	chromePath    string
}

func envInt(name string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return fallback
}

func loadConfig() config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}
	ua := os.Getenv("WAF_UA")
	if ua == "" {
		ua = defaultUA
	}
	return config{
		port:        port,
		wait:        time.Duration(envInt("WAF_WAIT_MS", 14000)) * time.Millisecond,
		healTimeout: time.Duration(envInt("WAF_HEAL_TIMEOUT", 120)) * time.Second,
		poll:        time.Duration(envInt("WAF_POLL_MS", 250)) * time.Millisecond,
		stableTicks: envInt("WAF_STABLE_TICKS", 3),
		userAgent:   ua,
		chromePath:  os.Getenv("CHROME_PATH"),
	}
}

type step struct {
	Step   string `json:"step"`
	Status int    `json:"status,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type fetchResponse struct {
	status int
	ct     string
	body   []byte
}

type cacheEntry struct {
	cookie string
	at     time.Time
}

type app struct {
	cfg       config
	http      *http.Client
	browser   *browser
	cacheMu   sync.Mutex
	cache     map[string]cacheEntry
	locks     sync.Map // host -> *sync.Mutex
}

func newApp(cfg config) *app {
	return &app{
		cfg:     cfg,
		http:    &http.Client{},
		browser: newBrowser(cfg),
		cache:   make(map[string]cacheEntry),
	}
}

func (a *app) cached(host string) string {
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	e, ok := a.cache[host]
	if !ok {
		return ""
	}
	if time.Since(e.at) > 90*time.Second {
		delete(a.cache, host)
		return ""
	}
	return e.cookie
}

func (a *app) setCached(host, cookie string) {
	a.cacheMu.Lock()
	a.cache[host] = cacheEntry{cookie: cookie, at: time.Now()}
	a.cacheMu.Unlock()
}

func (a *app) deleteCached(host string) {
	a.cacheMu.Lock()
	delete(a.cache, host)
	a.cacheMu.Unlock()
}

func (a *app) cachedDomains() []string {
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	for host, entry := range a.cache {
		if time.Since(entry.at) > 90*time.Second {
			delete(a.cache, host)
		}
	}
	items := make([]string, 0, len(a.cache))
	for host := range a.cache {
		items = append(items, host)
	}
	return items
}

func (a *app) doGet(target, cookie string) (fetchResponse, error) {
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fetchResponse{}, errors.New("URL 格式不正确")
	}
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return fetchResponse{}, errors.New("URL 格式不正确")
	}
	req.Header.Set("User-Agent", a.cfg.userAgent)
	req.Header.Set("Accept", "application/pdf,application/octet-stream,*/*")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	req.Header.Set("Referer", u.Scheme+"://"+u.Host+"/")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return fetchResponse{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fetchResponse{}, err
	}
	return fetchResponse{status: resp.StatusCode, ct: resp.Header.Get("Content-Type"), body: body}, nil
}

func hostOf(target string) (string, error) {
	u, err := url.Parse(target)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("URL 格式不正确")
	}
	return strings.ToLower(u.Host), nil
}

func (a *app) fetchWithHeal(target string) (fetchResponse, []step, error) {
	host, err := hostOf(target)
	if err != nil {
		return fetchResponse{}, nil, err
	}
	steps := make([]step, 0, 4)
	r, err := a.doGet(target, "")
	if err != nil {
		return fetchResponse{}, nil, err
	}
	steps = append(steps, step{Step: "direct", Status: r.status})
	if r.status != http.StatusPreconditionFailed {
		return r, steps, nil
	}
	if cookie := a.cached(host); cookie != "" {
		r2, getErr := a.doGet(target, cookie)
		if getErr != nil {
			return fetchResponse{}, nil, getErr
		}
		steps = append(steps, step{Step: "cached_cookie", Status: r2.status})
		if r2.status != http.StatusPreconditionFailed {
			return r2, steps, nil
		}
		a.deleteCached(host)
	}

	muAny, _ := a.locks.LoadOrStore(host, &sync.Mutex{})
	mu := muAny.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()

	// Another request for this host may have refreshed the cache while we waited.
	if cookie := a.cached(host); cookie != "" {
		r2, getErr := a.doGet(target, cookie)
		if getErr != nil {
			return fetchResponse{}, nil, getErr
		}
		steps = append(steps, step{Step: "cached_cookie", Status: r2.status})
		if r2.status != http.StatusPreconditionFailed {
			return r2, steps, nil
		}
		a.deleteCached(host)
	}

	cookie, err := a.browser.harvest(target, a.cfg.userAgent)
	if err != nil {
		return fetchResponse{}, nil, err
	}
	if cookie == "" {
		steps = append(steps, step{Step: "give_up", Reason: "未取得 Cookie"})
		return r, steps, nil
	}
	a.setCached(host, cookie)
	r3, err := a.doGet(target, cookie)
	if err != nil {
		return fetchResponse{}, nil, err
	}
	steps = append(steps, step{Step: "healed", Status: r3.status})
	if r3.status == http.StatusPreconditionFailed {
		a.deleteCached(host)
		steps = append(steps, step{Step: "give_up", Reason: "新 Cookie 仍被拒(412)"})
	}
	return r3, steps, nil
}

func isPDF(body []byte) bool {
	return len(body) >= 5 && string(body[:5]) == "%PDF-"
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		http.Error(w, `{"error":"JSON 序列化失败"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (a *app) handleFetch(w http.ResponseWriter, target, mode string) {
	if strings.TrimSpace(target) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少 url 参数"})
		return
	}
	r, steps, err := a.fetchWithHeal(target)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	ok := r.status == http.StatusOK && isPDF(r.body)
	switch mode {
	case "check":
		writeJSON(w, http.StatusOK, map[string]any{
			"url": target, "status": r.status, "content_type": r.ct,
			"length": len(r.body), "is_pdf": ok, "steps": steps,
		})
	case "token":
		host, err := hostOf(target)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		cookie := a.cached(host)
		writeJSON(w, http.StatusOK, map[string]any{
			"url": target, "status": r.status, "cookie_len": len(cookie),
			"cookie": cookie, "steps": steps,
		})
	default:
		if !ok {
			status := r.status
			if status < 400 {
				status = http.StatusBadGateway
			}
			writeJSON(w, status, map[string]any{
				"ok": false, "status": r.status, "content_type": r.ct,
				"length": len(r.body), "steps": steps,
				"hint": "目标未返回 PDF（挑战未通过或 URL 失效）",
			})
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Length", strconv.Itoa(len(r.body)))
		w.Header().Set("X-Waf-Status", strconv.Itoa(r.status))
		stepJSON, _ := json.Marshal(steps)
		w.Header().Set("X-Waf-Steps", string(stepJSON))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(r.body)
	}
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && r.URL.Path != "/health" {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "service": "waf-token-slim",
			"strategy": "直接 GET → 412 试域名缓存 Cookie → 仍 412 现场采集一次重放（不死循环）",
			"persistence": "不落盘：PDF 仅在内存中返回，Cookie 按域名缓存在进程内存",
			"cached_domains": a.cachedDomains(),
		})
	})
	mux.HandleFunc("/cache", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			a.cacheMu.Lock()
			defer a.cacheMu.Unlock()
			items := make(map[string]any)
			for host, entry := range a.cache {
				age := time.Since(entry.at)
				if age > 90*time.Second {
					delete(a.cache, host)
					continue
				}
				items[host] = map[string]any{"cookie_len": len(entry.cookie), "age_seconds": float64(int(age.Seconds()*10)) / 10}
			}
			writeJSON(w, http.StatusOK, map[string]any{"count": len(items), "domains": items})
		case http.MethodDelete:
			domain := strings.ToLower(r.URL.Query().Get("domain"))
			a.cacheMu.Lock()
			if domain != "" {
				delete(a.cache, domain)
			} else {
				clear(a.cache)
			}
			remaining := make([]string, 0, len(a.cache))
			for host := range a.cache {
				remaining = append(remaining, host)
			}
			a.cacheMu.Unlock()
			cleared := domain
			if cleared == "" {
				cleared = "*"
			}
			writeJSON(w, http.StatusOK, map[string]any{"cleared": cleared, "remaining": remaining})
		default:
			w.Header().Set("Allow", "GET, DELETE")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		}
	})
	mux.HandleFunc("/fetch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
			defer r.Body.Close()
			var payload struct {
				URL string `json:"url"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "JSON 格式错误"})
				return
			}
			a.handleFetch(w, payload.URL, "pdf")
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET, POST")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		a.handleFetch(w, r.URL.Query().Get("url"), "pdf")
	})
	for _, route := range []string{"/check", "/token"} {
		mode := strings.TrimPrefix(route, "/")
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				w.Header().Set("Allow", "GET")
				writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
				return
			}
			a.handleFetch(w, r.URL.Query().Get("url"), mode)
		})
	}
	return mux
}

func (a *app) shutdown() {
	a.browser.stop()
}

func main() {
	cfg := loadConfig()
	a := newApp(cfg)
	srv := &http.Server{
		Addr:              net.JoinHostPort("0.0.0.0", cfg.port),
		Handler:           a.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	stop := make(chan os.Signal, 1)
	signalNotify(stop)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		a.shutdown()
	}()
	log.Printf("[waf-token-slim] listening on :%s", cfg.port)
	log.Printf("[waf-token-slim] Chromium starts lazily on first healed request")
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func signalNotify(ch chan<- os.Signal) {
	// Kept separate to make main's shutdown path explicit.
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
}

type browser struct {
	cfg      config
	mu       sync.Mutex
	proc     *exec.Cmd
	profile  string
	cdp      *cdpClient
	procDone chan struct{}
}

func newBrowser(cfg config) *browser { return &browser{cfg: cfg} }

func (b *browser) findBinary() (string, error) {
	if b.cfg.chromePath != "" {
		if _, err := os.Stat(b.cfg.chromePath); err != nil {
			return "", fmt.Errorf("CHROME_PATH 不存在: %s", b.cfg.chromePath)
		}
		return b.cfg.chromePath, nil
	}
	for _, candidate := range []string{
		"/usr/lib/chromium/chromium-headless-shell",
		"/usr/bin/chromium", "/usr/bin/chromium-browser",
		"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
	} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", errors.New("未找到 Chromium，请设置 CHROME_PATH")
}

func (b *browser) start() (*cdpClient, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cdp != nil {
		select {
		case <-b.procDone:
			return nil, errors.New("Chromium 已退出")
		default:
			return b.cdp, nil
		}
	}
	bin, err := b.findBinary()
	if err != nil {
		return nil, err
	}
	profile, err := os.MkdirTemp(os.TempDir(), "waf_prof_srv_*")
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = os.RemoveAll(profile)
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	args := []string{
		"--headless=new", fmt.Sprintf("--remote-debugging-port=%d", port),
		"--no-first-run", "--no-default-browser-check", "--disable-gpu",
		"--no-sandbox", "--disable-dev-shm-usage", "--user-data-dir=" + profile,
		"--disable-blink-features=AutomationControlled", "--window-size=1920,1080", "about:blank",
	}
	cmd := exec.Command(bin, args...)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(profile)
		return nil, fmt.Errorf("启动 Chromium 失败: %w", err)
	}
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	b.proc, b.profile, b.procDone = cmd, profile, done
	debugHTTP := &http.Client{Timeout: 2 * time.Second}
	var wsURL string
	for i := 0; i < 80; i++ {
		select {
		case <-done:
			return nil, errors.New("Chromium 提前退出")
		default:
		}
		resp, reqErr := debugHTTP.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", port))
		if reqErr == nil {
			var version struct {
				WebSocketURL string `json:"webSocketDebuggerUrl"`
			}
			decodeErr := json.NewDecoder(resp.Body).Decode(&version)
			_ = resp.Body.Close()
			if decodeErr == nil && version.WebSocketURL != "" {
				wsURL = version.WebSocketURL
				break
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	if wsURL == "" {
		_ = cmd.Process.Kill()
		return nil, errors.New("Chromium 启动超时 / CDP 未就绪")
	}
	cdp, err := dialCDP(wsURL, b.cfg.healTimeout)
	if err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("CDP WebSocket 连接失败: %w", err)
	}
	b.cdp = cdp
	return cdp, nil
}

func (b *browser) stop() {
	b.mu.Lock()
	proc, profile, done, cdp := b.proc, b.profile, b.procDone, b.cdp
	b.mu.Unlock()
	if cdp != nil {
		_ = cdp.conn.Close()
	}
	if proc != nil && proc.Process != nil {
		_ = proc.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = proc.Process.Kill()
			<-done
		}
	}
	if profile != "" {
		_ = os.RemoveAll(filepath.Clean(profile))
	}
}

func (b *browser) harvest(target, ua string) (string, error) {
	client, err := b.start()
	if err != nil {
		return "", err
	}
	var contextResult struct {
		BrowserContextID string `json:"browserContextId"`
	}
	if err := client.callInto("Target.createBrowserContext", map[string]any{"disposeOnDetach": false}, "", &contextResult); err != nil {
		return "", err
	}
	contextID := contextResult.BrowserContextID
	defer func() {
		_, _ = client.call("Target.disposeBrowserContext", map[string]any{"browserContextId": contextID}, "")
	}()
	var targetResult struct {
		TargetID string `json:"targetId"`
	}
	if err := client.callInto("Target.createTarget", map[string]any{"url": "about:blank", "browserContextId": contextID}, "", &targetResult); err != nil {
		return "", err
	}
	targetID := targetResult.TargetID
	defer func() { _, _ = client.call("Target.closeTarget", map[string]any{"targetId": targetID}, "") }()
	var attachResult struct {
		SessionID string `json:"sessionId"`
	}
	if err := client.callInto("Target.attachToTarget", map[string]any{"targetId": targetID, "flatten": true}, "", &attachResult); err != nil {
		return "", err
	}
	session := attachResult.SessionID
	for _, method := range []string{"Network.enable", "Page.enable", "Runtime.enable"} {
		if _, err := client.call(method, map[string]any{}, session); err != nil {
			return "", err
		}
	}
	_, _ = client.call("Browser.setDownloadBehavior", map[string]any{"behavior": "deny"}, session)
	_, _ = client.call("Page.setDownloadBehavior", map[string]any{"behavior": "deny"}, session)
	_, err = client.call("Network.setUserAgentOverride", map[string]any{
		"userAgent": ua, "platform": "Windows", "acceptLanguage": "zh-CN,zh;q=0.9",
	}, session)
	if err != nil {
		return "", err
	}
	if _, err := client.call("Page.navigate", map[string]any{"url": target}, session); err != nil {
		return "", err
	}
	u, _ := url.Parse(target)
	deadline := time.Now().Add(b.cfg.wait)
	lastSig, cookie := "", ""
	stable := 0
	for time.Now().Before(deadline) {
		time.Sleep(b.cfg.poll)
		var result struct {
			Cookies []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
				Domain string `json:"domain"`
			} `json:"cookies"`
		}
		if err := client.callInto("Network.getAllCookies", map[string]any{}, session, &result); err != nil {
			return "", err
		}
		cookies := matchingCookies(result.Cookies, u.Hostname())
		if len(cookies) == 0 {
			continue
		}
		sigParts := make([]string, 0, len(cookies))
		for _, c := range cookies {
			sigParts = append(sigParts, c.Name+"="+c.Value)
		}
		sort.Strings(sigParts)
		sig := strings.Join(sigParts, ";")
		cookie = joinCookies(cookies)
		if sig == lastSig {
			stable++
			if stable >= b.cfg.stableTicks {
				return cookie, nil
			}
		} else {
			stable, lastSig = 0, sig
		}
	}
	return cookie, nil
}

type cookie struct {
	Name   string
	Value  string
	Domain string
}

func matchingCookies(input []struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Domain string `json:"domain"`
}, host string) []cookie {
	var out []cookie
	for _, c := range input {
		domain := strings.TrimPrefix(strings.ToLower(c.Domain), ".")
		if strings.EqualFold(host, domain) || strings.HasSuffix(strings.ToLower(host), "."+domain) {
			out = append(out, cookie{Name: c.Name, Value: c.Value, Domain: c.Domain})
		}
	}
	return out
}

func joinCookies(cookies []cookie) string {
	parts := make([]string, 0, len(cookies))
	for _, c := range cookies {
		parts = append(parts, c.Name+"="+c.Value)
	}
	return strings.Join(parts, "; ")
}

type cdpMessage struct {
	ID        int64           `json:"id"`
	Result    json.RawMessage `json:"result"`
	Error     *struct { Message string `json:"message"` } `json:"error"`
	SessionID string          `json:"sessionId,omitempty"`
}

type cdpClient struct {
	conn    *websocket.Conn
	timeout time.Duration
	nextID  atomic.Int64
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[int64]chan cdpMessage
}

func dialCDP(wsURL string, timeout time.Duration) (*cdpClient, error) {
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return nil, err
	}
	c := &cdpClient{conn: conn, timeout: timeout, pending: make(map[int64]chan cdpMessage)}
	go c.readLoop()
	return c, nil
}

func (c *cdpClient) readLoop() {
	defer func() {
		c.mu.Lock()
		for id, ch := range c.pending {
			ch <- cdpMessage{ID: id, Error: &struct { Message string `json:"message"` }{Message: "CDP 连接关闭"}}
			delete(c.pending, id)
		}
		c.mu.Unlock()
	}()
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		var msg cdpMessage
		if json.Unmarshal(data, &msg) != nil || msg.ID == 0 {
			continue
		}
		c.mu.Lock()
		ch := c.pending[msg.ID]
		delete(c.pending, msg.ID)
		c.mu.Unlock()
		if ch != nil {
			ch <- msg
		}
	}
}

func (c *cdpClient) call(method string, params any, session string) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	ch := make(chan cdpMessage, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()
	message := map[string]any{"id": id, "method": method, "params": params}
	if session != "" {
		message["sessionId"] = session
	}
	c.writeMu.Lock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
	err := c.conn.WriteJSON(message)
	c.writeMu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}
	select {
	case response := <-ch:
		if response.Error != nil {
			return nil, errors.New(response.Error.Message)
		}
		return response.Result, nil
	case <-time.After(c.timeout):
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("CDP 超时: %s", method)
	}
}

func (c *cdpClient) callInto(method string, params any, session string, out any) error {
	data, err := c.call(method, params, session)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("解析 CDP 响应失败 (%s): %w", method, err)
	}
	return nil
}
