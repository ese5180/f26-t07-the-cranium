/*
 * Location by Wi-Fi, from 1.13.0: what access points the board hears, for a position that AWS IoT
 * Core Device Location works out in the cloud. See "Location" in firmware/README.md and
 * docs/fleet.md.
 *
 * The board scans for access points while it is connected, keeps the strongest few, and publishes
 * them to cranium/<thing name>/location, at QoS 0:
 *
 *   {"aps":[{"mac":"a4:2b:b0:12:34:56","rss":-51},{"mac":"f0:9f:c2:65:43:21","rss":-70}],
 *    "boot":42,"t":61234}
 *
 * aps are at most LOCATION_APS_MAX access points, strongest first, each by its address (BSSID) and
 * its signal in dBm, and never by its network's name. Only globally administered, individual
 * addresses count: a phone's hotspot and other randomised addresses move with whoever carries them.
 * With fewer than LOCATION_APS_MIN left, nothing is sent. boot is the boot diary's count of boots,
 * and t the uptime in milliseconds when the scan ended.
 *
 * When: once a boot, when a connection has lasted LOCATION_SETTLE_MS, then every
 * LOCATION_PERIOD_MS, and when the console's report command asks for one; never sooner than
 * LOCATION_FLOOR_MS after the last scan began. Never while an update is under way (any update state
 * but idle), while Bluetooth is open, or while the board is not connected. A scan whose result is
 * not sent, because the connection went, leaves the boot's first one still to do.
 *
 * The scan covers the 2.4 GHz band only, about a second in all. The association stays: see
 * "Location" in firmware/README.md for what a scan does to the link.
 */

#ifndef LOCATION_H_
#define LOCATION_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define LOCATION_APS_MAX          10
#define LOCATION_APS_MIN          2

#define LOCATION_SETTLE_MS        (60 * 1000)
#define LOCATION_PERIOD_MS        (6LL * 60 * 60 * 1000)
#define LOCATION_FLOOR_MS         (10 * 60 * 1000)
/* After the Wi-Fi stack refused to start a scan, which it does while it scans for itself. */
#define LOCATION_RETRY_MS         (60 * 1000)
/* The driver ends a scan after 30 s (CONFIG_WIFI_NRF70_SCAN_TIMEOUT_S): this, if its end is lost. */
#define LOCATION_SCAN_LIMIT_MS    (40 * 1000)

/*
 * AWS IoT closes the connection of a board that publishes where its policy does not allow. A
 * connection that ends within LOCATION_PROOF_MS of a location is counted, and after
 * LOCATION_REFUSALS_MAX of those, no scan is made until a restart. Updates go on as before.
 */
#define LOCATION_PROOF_MS         5000
#define LOCATION_REFUSALS_MAX     2

/*
 * The longest message, with its terminating NUL: ten access points with the longest signal there is
 * (-127), and boot and t at their largest. tests/host/test_location.c makes one.
 */
#define LOCATION_JSON_MAX         442

struct location_ap {
	uint8_t mac[6];
	int8_t rss;
};

/* What a scan has kept so far: strongest first, no address twice. */
struct location_aps {
	struct location_ap ap[LOCATION_APS_MAX];
	uint8_t count;
};

/* What stands in the way of a scan now. */
enum location_hold {
	LOCATION_GO,
	/* This board has no Wi-Fi location: a build without CONFIG_APP_LOCATION. */
	LOCATION_NONE,
	/* AWS IoT closed the connection after a location, LOCATION_REFUSALS_MAX times. */
	LOCATION_OFF,
	LOCATION_SCANNING,
	LOCATION_OFFLINE,
	LOCATION_UPDATE,
	LOCATION_BLUETOOTH,
	LOCATION_FLOOR,
	LOCATION_RETRY,
	/* Only for a scan that nobody asked for: the connection is younger than LOCATION_SETTLE_MS. */
	LOCATION_SETTLING,
	/* Only for a scan that nobody asked for: the boot's first is done, and the period is not up. */
	LOCATION_NOT_DUE,
};

/* One access point that a scan heard, by its address and signal: kept or not. */
void location_keep(struct location_aps *aps, const uint8_t mac[6], int rss);

/* The message: its length without the NUL, -ENODATA for too few access points, or -ENOSPC. */
int location_format(const struct location_aps *aps, uint32_t boot, int64_t t, char *buf,
		    size_t len);

#if defined(CONFIG_APP_LOCATION)

/* Before the network comes up: listens for the results of scans. */
void location_init(void);

/* The main loop's, once a second: a scan when one is due and nothing holds it. */
void location_on_tick(void);

/* The main loop's: the connection to AWS IoT went. */
void location_on_cloud_down(void);

/* The main loop's: a scan now, for the report command, unless something holds it, and what does. */
enum location_hold location_request(void);

#else

static inline void location_init(void)
{
}

static inline void location_on_tick(void)
{
}

static inline void location_on_cloud_down(void)
{
}

static inline enum location_hold location_request(void)
{
	return LOCATION_NONE;
}

#endif /* CONFIG_APP_LOCATION */

#endif /* LOCATION_H_ */
