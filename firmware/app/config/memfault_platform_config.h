/*
 * The Memfault SDK's settings for this firmware, from 1.14.0 (docs/memfault.md). Most come from
 * Kconfig, in prj.conf; this file holds what only the SDK's headers can take. CMakeLists.txt puts
 * this directory on the include path of every library, which is where the SDK looks for it.
 */

#pragma once

/*
 * A trace event's text: the reason of an update that failed or was refused, and what the image
 * said ("incompatible_board: image is for nrf5340dk"). It waits in the SDK's event storage until
 * it is sent, so it is kept short.
 */
#define MEMFAULT_TRACE_EVENT_MAX_LOG_LEN 64

/* Nothing here records a trace event in an interrupt, so the SDK keeps no room for one. */
#define MEMFAULT_TRACE_EVENT_WITH_LOG_FROM_ISR_ENABLED 0
