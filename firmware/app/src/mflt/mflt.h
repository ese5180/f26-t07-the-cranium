/*
 * Memfault, from 1.14.0 (docs/memfault.md): the device ID, the chunks over AWS IoT
 * (src/mflt/mflt_link.h), this firmware's metrics and trace events, and why it restarts itself.
 *
 * Without CONFIG_APP_MEMFAULT every function here does nothing, so the rest of the firmware calls
 * them as they are. Unless it says otherwise, a function is for the main loop only.
 */

#ifndef MFLT_H_
#define MFLT_H_

#include <stdbool.h>
#include <stdint.h>

/* Why this firmware is about to restart the board itself. */
enum mflt_reboot {
	/* An update is handed to the bootloader. */
	MFLT_REBOOT_UPDATE,
	/* A new image's trial ran out, and the bootloader will put the old one back. */
	MFLT_REBOOT_TRIAL_FAILED,
	/* RESET on the serial console. */
	MFLT_REBOOT_USER,
	/* Button 2 held: everything provisioned is erased. */
	MFLT_REBOOT_FACTORY_RESET,
	/* The three timers of src/stuck.c. */
	MFLT_REBOOT_STUCK_WIFI_SILENT,
	MFLT_REBOOT_STUCK_NO_CLOUD,
	MFLT_REBOOT_STUCK_UPDATE_STALL,
};

/* How an update from the cloud ended. */
enum mflt_update_end {
	MFLT_UPDATE_SUCCEEDED,
	MFLT_UPDATE_FAILED,
	MFLT_UPDATE_REFUSED,
	MFLT_UPDATE_ROLLED_BACK,
};

#if defined(CONFIG_APP_MEMFAULT)

/* After identity_init(): Memfault's device ID becomes the thing name. */
void mflt_init(void);

void mflt_on_cloud_up(void);
void mflt_on_cloud_down(void);
void mflt_on_net_up(void);
void mflt_on_net_down(void);
void mflt_on_tick(void);

/* Send what is waiting now, without the back-off: the report and memfault commands. */
void mflt_drain_now(void);

/* Take a heartbeat of the metrics now, and send it: the memfault command. */
void mflt_heartbeat_now(void);

/* The cloud's answer for chunk seq, from the MQTT library's thread (command.c). */
void mflt_on_answer(uint16_t seq);

/* Right before the board restarts itself, from any thread. */
void mflt_reboot_mark(enum mflt_reboot why);

/* The connection to AWS IoT, from the MQTT library's thread (cloud.c). */
void mflt_note_cloud_connected(void);
void mflt_note_cloud_lost(void);

/* A shadow report got out, or did not (cloud.c). */
void mflt_note_report(bool sent);

/* The cloud accepted the start of an update (ota.c). */
void mflt_note_update_started(void);

/*
 * An update from the cloud ended (ota.c): a trace event with the reason, as the job's status says
 * it, and what it is about. Both are text this firmware made, never a secret.
 */
void mflt_note_update_end(enum mflt_update_end end, const char *reason, const char *detail);

#else

static inline void mflt_init(void)
{
}

static inline void mflt_on_cloud_up(void)
{
}

static inline void mflt_on_cloud_down(void)
{
}

static inline void mflt_on_net_up(void)
{
}

static inline void mflt_on_net_down(void)
{
}

static inline void mflt_on_tick(void)
{
}

static inline void mflt_drain_now(void)
{
}

static inline void mflt_heartbeat_now(void)
{
}

static inline void mflt_on_answer(uint16_t seq)
{
	(void)seq;
}

static inline void mflt_reboot_mark(enum mflt_reboot why)
{
	(void)why;
}

static inline void mflt_note_cloud_connected(void)
{
}

static inline void mflt_note_cloud_lost(void)
{
}

static inline void mflt_note_report(bool sent)
{
	(void)sent;
}

static inline void mflt_note_update_started(void)
{
}

static inline void mflt_note_update_end(enum mflt_update_end end, const char *reason,
					const char *detail)
{
	(void)end;
	(void)reason;
	(void)detail;
}

#endif /* CONFIG_APP_MEMFAULT */

#endif /* MFLT_H_ */
