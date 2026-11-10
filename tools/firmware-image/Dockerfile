# The firmware build's toolchain and SDK, ready made. docs/ci.md, "The firmware build image".
#
# It starts from Nordic's own image, pinned by digest to the one .github/workflows/ci.yml builds in
# (the Zephyr SDK, west, CMake, Ninja, the Python tools), and adds the nRF Connect SDK at the same
# commit that ci.yml checks, so a job does not have to fetch it. It holds neither this repository
# nor any key or secret.
#
#   docker build -t cranium-firmware tools/firmware-image
FROM ghcr.io/nrfconnect/sdk-nrf-toolchain:v3.4.0@sha256:f1dca44678dae83e37404e33f369786f5b2ffe2ed497eec1815f66c3a868bace

# As NCS_VERSION and NCS_COMMIT in ci.yml. Change them together.
ARG NCS_VERSION=v3.4.0
ARG NCS_COMMIT=99553055607b2e9885fbc80ccd11fa9da81c2df0

# The base image puts the toolchain on the PATH through BASH_ENV, which only bash reads.
SHELL ["/bin/bash", "-c"]

RUN set -euo pipefail \
    && west init -m https://github.com/nrfconnect/sdk-nrf --mr "${NCS_VERSION}" --clone-opt=--depth=1 /opt/ncs \
    && cd /opt/ncs \
    && test "$(git -C nrf rev-parse HEAD)" = "${NCS_COMMIT}" \
    && west update --narrow --fetch-opt=--depth=1 \
    && rm -rf /root/.cache

ENV ZEPHYR_BASE=/opt/ncs/zephyr
WORKDIR /workdir
