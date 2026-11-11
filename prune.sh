#!/bin/sh
# Stage a pruned headless-shell runtime for the final image.
# The final image copies this directory plus the required shared libraries.
set -eu

mkdir -p /opt/keep
if [ -d /usr/lib/chromium ]; then
  mv /usr/lib/chromium /opt/keep/chromium
fi

# Remove the Mesa software-rendering stack unused by headless-shell.
rm -f /usr/lib/libLLVM.so* /usr/lib/libgallium*.so*
rm -rf /usr/lib/dri /usr/share/man /usr/share/doc /usr/share/icons
