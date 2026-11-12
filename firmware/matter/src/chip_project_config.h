/*
 * CHIP project config for the on-device commissioner.
 * Pulled in via CONFIG_CHIP_PROJECT_CONFIG.
 *
 * In plain English: This is a small settings file that the Matter software (CHIP =
 * the open-source code that implements the Matter smart-home standard) reads at
 * build time to know which optional features to switch on. Most settings are
 * already chosen for us by Nordic's SDK (the nRF Connect SDK, or "NCS", the vendor
 * toolkit this firmware is built with). If we set one of those again here, the
 * build would error out complaining it was defined twice. So this file only adds
 * the couple of settings NCS leaves off — the ones that turn this chip into a
 * "commissioner" (the hub/brain that adds and controls smart devices), because
 * Nordic normally ships firmware for the devices being controlled, not the hub.
 *
 * IMPORTANT: the nrfconnect platform config (CHIPDevicePlatformConfig.h) already
 * #defines almost everything from Kconfig (VID/PID, ENABLE_THREAD, ENABLE_CHIPOBLE,
 * ENABLE_THREAD_SRP_CLIENT/DNS_CLIENT, fabrics, read-client, ...). Redefining any
 * of those here is a -Werror redefinition. The ONE thing NCS does not set — because
 * it ships accessory-only — is the commissioner/controller enable. That is all we add.
 */

// Ensures this header is included only once per build, even if referenced multiple
// times, so its settings aren't defined twice.
#pragma once

// This single switch enables all the "hub" code — the parts that let this chip
// add new smart devices to the network and control them (the commissioner role).
// Turn on the on-device commissioner/controller code paths.
#define CHIP_DEVICE_CONFIG_ENABLE_COMMISSIONER 1

// How many devices this hub can be actively setting up at the same moment. We set
// it to 2 (very small) on purpose. The comment below explains why: the standard
// default of 64 is meant for a hub running on a full computer with lots of memory.
// On this tiny chip, reserving room for 64 simultaneous setups would eat far more
// memory (SRAM = the chip's fast working memory) than the chip even has. This hub
// only pairs one device at a time, so a tiny number is plenty.
//
// Correction to the wording just above: 124 KB does NOT exceed the chip's 256 KB of
// SRAM (it is under half of it). The real problem is that 124 KB is an unacceptably
// LARGE FRACTION of that 256 KB budget — memory this hub needs for everything else —
// not that it is more memory than the chip physically has.
//
// Plain-English gloss for the terse developer note below: "chip-tool" is Matter's
// commissioner app that runs on a full PC (which has gigabytes of memory to spare).
// "DeviceCommissioner" is the software object that runs the pairing process.
// "ObjectPool<CommissioneeDeviceProxy, N>" just means it pre-reserves memory for N
// devices-being-paired up front — so N=64 pre-reserves a big chunk of RAM even when
// only one device is ever paired at a time.
// CRITICAL for RAM: the upstream default is 64 (a host commissioner like chip-tool).
// The DeviceCommissioner allocates ObjectPool<CommissioneeDeviceProxy, N>, and at
// N=64 that pool alone is ~124 KB of SRAM — a large share of the RAM this board has.
// This on-device controller commissions one device at a time, so a small pool suffices.
#define CHIP_CONFIG_CONTROLLER_MAX_ACTIVE_DEVICES 2
