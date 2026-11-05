/*
 * Events handled by the application's single event loop.
 *
 * Library callbacks run on several threads (MQTT, downloader, input, network
 * management), and the serial console has a task of its own. They only post one of
 * these events; every state change then happens on the main thread, one event at a time.
 */

#ifndef APP_EVENTS_H_
#define APP_EVENTS_H_

#include <stdbool.h>
#include <stdint.h>

enum app_event_type {
	APP_EVENT_NET_UP,
	APP_EVENT_NET_DOWN,
	/* Start joining the stored network. */
	APP_EVENT_NET_JOIN,
	/* An attempt to join did not work out. */
	APP_EVENT_NET_JOIN_FAILED,
	APP_EVENT_CLOUD_UP,
	APP_EVENT_CLOUD_DOWN,
	/* The cloud settings have changed: connect again soon, with the new ones. */
	APP_EVENT_CLOUD_CHANGED,
	/*
	 * Asked for on the console: close the connection, or let the attempt under way end, and
	 * connect again at once, with the back-off from the start. Ignored during an update.
	 */
	APP_EVENT_CLOUD_RECONNECT,
	/* A jobs message (the next job, or the reply to a request for it) is waiting. */
	APP_EVENT_JOB_MESSAGE,
	/* AWS IoT answered a job status update that the update logic is waiting on. */
	APP_EVENT_JOB_ACK,
	APP_EVENT_BUTTON,
	APP_EVENT_DOWNLOAD,
	/* Once a second. */
	APP_EVENT_TICK,
	/* Run a function here: how the console task reads and changes what this loop owns. */
	APP_EVENT_CALL,
};

enum app_button {
	APP_BUTTON_1,
	APP_BUTTON_2,
};

enum app_download_event {
	APP_DOWNLOAD_PROGRESS,
	APP_DOWNLOAD_FINISHED,
	APP_DOWNLOAD_ERROR,
	APP_DOWNLOAD_CANCELLED,
};

struct app_event {
	enum app_event_type type;
	union {
		struct {
			uint8_t id;
			bool long_press;
#if defined(CONFIG_APP_BT_OTA)
			/* A real press of a real button, not a command on the console. */
			bool physical;
#endif
		} button;
		struct {
			uint8_t what;
			/* Percent for progress, library error cause for an error. */
			int16_t value;
		} download;
		struct {
			/* Which update this answers: the token it was sent with. */
			char kind;
			uint16_t sequence;
			bool accepted;
			/* Rejected for a reason that sending it again cannot change. */
			bool permanent;
		} job_ack;
		struct {
			int16_t reason;
		} join_failed;
		struct {
			void (*function)(void);
		} call;
	};
};

/* Queue an event for the main loop. Safe from any thread and from interrupts. */
int app_event_post(const struct app_event *event);

/* Shorthand for events that carry no data. */
int app_event_post_simple(enum app_event_type type);

/*
 * The most seconds until the main loop tries to connect to AWS IoT again, or -1 if no attempt
 * is scheduled. Only on the main loop: the console reads it through console_port_on_main().
 */
int app_cloud_retry_in(void);

/*
 * The heartbeat and the diagnostics report, now, if the board is connected: for the console's
 * report command (command.h). Only on the main loop.
 */
void app_send_reports(void);

/*
 * Restart, once the console has what the board said: the lines that wait, and the report with the
 * update's state as `rebooting`, which AWS IoT acknowledges, for at most 2 s. Offline, at once. From
 * 1.14.0, for Button 1 on an image that came over Bluetooth. Only on the main loop. why is an
 * enum mflt_reboot (src/mflt.h). Does not return.
 */
void app_restart(int why);

#endif /* APP_EVENTS_H_ */
