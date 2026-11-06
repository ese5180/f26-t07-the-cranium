#!/usr/bin/env bash
# The tools the Linux packages need on an Ubuntu runner (release-apps.yml's Desktop app job and the Desktop app
# for Linux workflow run it): rpmbuild, which electron-builder's fpm calls for the .rpm. The AppImage and the
# .deb need nothing more than electron-builder brings.
set -euo pipefail
sudo apt-get update -qq
sudo apt-get install -y -qq rpm > /dev/null
rpmbuild --version
