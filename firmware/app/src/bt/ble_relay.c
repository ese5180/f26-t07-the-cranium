#include "ble_relay.h"

#include <errno.h>
#include <string.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/l2cap.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/dns_resolve.h>
#include <zephyr/net/net_ip.h>
#include <zephyr/net/socket.h>
#include <zephyr/net/socket_offload.h>
#include <zephyr/net_buf.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/fdtable.h>
#include <zephyr/sys/ring_buffer.h>

#include "app_events.h"
#include "ble_relay_policy.h"
#include "ble_relay_proto.h"
#include "bt_ota.h"
#include "cloud.h"
#include "console.h"
#include "device.h"
#include "identity.h"
#include "net.h"

LOG_MODULE_REGISTER(ble_relay, CONFIG_APP_LOG_LEVEL);

#if !defined(CONFIG_BT_L2CAP_DYNAMIC_CHANNEL) || !defined(CONFIG_BT_L2CAP_SEG_RECV) ||              \
	!defined(CONFIG_NET_SOCKETS_OFFLOAD) || !defined(CONFIG_NET_SOCKETS_SOCKOPT_TLS)
#error "The relay needs L2CAP channels with segment receive, the DNS hook and the TLS socket layer"
#endif

/*
 * The relay socket family sits between the TLS layer, which must see the socket call first, and the
 * native one: NET_SOCKET_REGISTER takes the priority as a literal.
 */
#define RELAY_SOCKET_PRIORITY 48
BUILD_ASSERT(CONFIG_NET_SOCKETS_TLS_PRIORITY < RELAY_SOCKET_PRIORITY &&
		     RELAY_SOCKET_PRIORITY < CONFIG_NET_SOCKETS_PRIORITY_DEFAULT,
	     "the relay must come after TLS and before the native sockets");

/* What a phone sends lands here, out of its frames, until the TLS layer reads it. */
#define RX_SIZE CONFIG_APP_BLE_RELAY_RX_SIZE
/* Each credit is one segment of at most this many bytes. */
#define RX_MPS  247
BUILD_ASSERT(RX_MPS <= BT_L2CAP_RX_MTU, "the MPS must fit an ACL buffer");
BUILD_ASSERT(RX_SIZE >= RX_MPS, "the ring must hold one segment at least");
/* The largest SDU a phone may send: a frame or pieces of several, which seg_recv takes as they come. */
#define RX_MTU  (BLE_RELAY_HEADER_LEN + BLE_RELAY_PAYLOAD_MAX)
/* The largest SDU the board sends, its frame header included: one ACL buffer's worth. */
#define TX_SDU  247
#define TX_DATA (TX_SDU - BLE_RELAY_HEADER_LEN)
BUILD_ASSERT(BLE_RELAY_HEADER_LEN + 2 + BLE_RELAY_HOST_MAX <= TX_SDU, "OPEN must fit one SDU");
BUILD_ASSERT(BLE_RELAY_HEADER_LEN + 4 + BLE_RELAY_NAME_MAX <= TX_SDU, "HELLO must fit one SDU");

/* 192.0.2.1 (TEST-NET-1, RFC 5737): routed nowhere, so nothing but the relay socket takes it. */
static const uint8_t relay_address[4] = { 192, 0, 2, 1 };

/* ---- shared state: under the lock ------------------------------------------------------------ */

static struct k_spinlock lock;
static struct ble_relay_session session;
static struct ble_relay_reader reader;
static uint16_t credits_out;
RING_BUF_DECLARE(rx_ring, RX_SIZE);

static struct {
	bool in_use;
	bool nonblock;
} sock;

/* Raised whenever there may be something to read, room to send, or the stream changed. */
static struct k_poll_signal readable = K_POLL_SIGNAL_INITIALIZER(readable);
static struct k_poll_signal writable = K_POLL_SIGNAL_INITIALIZER(writable);
static K_SEM_DEFINE(changed, 0, 1);

static atomic_t channel_open;
static atomic_t routing;
static atomic_t tx_busy;
/* The host the cloud connects to, set while routing: the only name the DNS hook answers. */
static char route_host[BLE_RELAY_HOST_MAX + 1];

static struct bt_l2cap_le_chan relay_chan;
static struct bt_l2cap_server server;
static bool server_registered;
static uint16_t psm_value;

static struct ble_relay_offer offer;
/* The main loop's, for the console: what it last said. */
static enum ble_relay_state said_state;
static bool said_channel;

/* ---- sending ---------------------------------------------------------------------------- */

/* The pool's destroy can run in an interrupt: only atomics and a signal here. */
static void tx_destroy(struct net_buf *buf)
{
	net_buf_destroy(buf);
	(void)atomic_dec(&tx_busy);
	(void)k_poll_signal_raise(&writable, 0);
}

NET_BUF_POOL_DEFINE(tx_pool, CONFIG_APP_BLE_RELAY_TX_BUFFERS, BT_L2CAP_SDU_BUF_SIZE(TX_SDU),
		    CONFIG_BT_CONN_TX_USER_DATA_SIZE, tx_destroy);

static struct net_buf *tx_alloc(k_timeout_t timeout)
{
	struct net_buf *buf = net_buf_alloc(&tx_pool, timeout);

	if (buf != NULL) {
		(void)atomic_inc(&tx_busy);
		net_buf_reserve(buf, BT_L2CAP_SDU_CHAN_SEND_RESERVE);
	}
	return buf;
}

static int tx_send(struct net_buf *buf)
{
	int err = atomic_get(&channel_open) ? bt_l2cap_chan_send(&relay_chan.chan, buf) : -ENOTCONN;

	if (err < 0) {
		net_buf_unref(buf);
	}
	return err;
}

static int send_frame(const uint8_t *frame, size_t len, k_timeout_t timeout)
{
	struct net_buf *buf = tx_alloc(timeout);

	if (buf == NULL) {
		return -ENOBUFS;
	}

	net_buf_add_mem(buf, frame, len);
	return tx_send(buf);
}

static void wake(void)
{
	(void)k_poll_signal_raise(&readable, 0);
	(void)k_poll_signal_raise(&writable, 0);
	k_sem_give(&changed);
}

static void drop_channel(void)
{
	if (atomic_get(&channel_open)) {
		(void)bt_l2cap_chan_disconnect(&relay_chan.chan);
	}
}

/*
 * What the policy asked for, outside the lock. timeout is how long a frame may wait for a buffer: none on
 * the Bluetooth host's thread. A frame that cannot go costs the channel: the phone then sees the link end.
 */
static void carry_out(uint32_t actions, k_timeout_t timeout)
{
	uint8_t frame[BLE_RELAY_HEADER_LEN + 4 + BLE_RELAY_NAME_MAX];
	int len;

	if (actions & BLE_RELAY_DO_HELLO) {
		len = ble_relay_hello(BLE_RELAY_PAYLOAD_MAX, identity_thing_name(), frame, sizeof(frame));
		if (len < 0 || send_frame(frame, (size_t)len, timeout) != 0) {
			actions |= BLE_RELAY_DO_DROP;
		}
	}

	if (actions & BLE_RELAY_DO_CLOSE) {
		uint8_t reason;
		k_spinlock_key_t key = k_spin_lock(&lock);

		reason = session.reason;
		k_spin_unlock(&lock, key);
		len = ble_relay_close(reason, frame);
		if (send_frame(frame, (size_t)len, timeout) != 0) {
			actions |= BLE_RELAY_DO_DROP;
		}
	}

	if (actions & BLE_RELAY_DO_WAKE) {
		wake();
	}

	if (actions & BLE_RELAY_DO_DROP) {
		drop_channel();
	}
}

/* Give the phone the credits there is room for. Any thread but the host's while it connects. */
static void give_credits(void)
{
	k_spinlock_key_t key = k_spin_lock(&lock);
	uint16_t due = ble_relay_credits_due(ring_buf_space_get(&rx_ring), credits_out, RX_MPS);

	if (!session.channel) {
		due = 0;
	}
	credits_out += due;
	k_spin_unlock(&lock, key);

	if (due > 0 && bt_l2cap_chan_give_credits(&relay_chan.chan, due) != 0) {
		key = k_spin_lock(&lock);
		credits_out -= due;
		k_spin_unlock(&lock, key);
	}
}

/* ---- the channel: on the Bluetooth host's thread ------------------------------------------- */

static void on_chan_connected(struct bt_l2cap_chan *chan)
{
	k_spinlock_key_t key;
	uint32_t actions;

	ARG_UNUSED(chan);

	(void)atomic_set(&channel_open, 1);
	key = k_spin_lock(&lock);
	actions = ble_relay_on_channel(&session, true);
	k_spin_unlock(&lock, key);
	carry_out(actions, K_NO_WAIT);
	(void)app_event_post_simple(APP_EVENT_RELAY_UP);
}

static void on_chan_disconnected(struct bt_l2cap_chan *chan)
{
	k_spinlock_key_t key;
	uint32_t actions;

	ARG_UNUSED(chan);

	(void)atomic_set(&channel_open, 0);
	key = k_spin_lock(&lock);
	actions = ble_relay_on_channel(&session, false);
	credits_out = 0;
	k_spin_unlock(&lock, key);
	carry_out(actions & ~(BLE_RELAY_DO_CLOSE | BLE_RELAY_DO_DROP), K_NO_WAIT);
	(void)app_event_post_simple(APP_EVENT_RELAY_DOWN);
}

/* Each segment used up one credit. Its stream bytes go to the ring, which the credits made room for. */
static void on_seg_recv(struct bt_l2cap_chan *chan, size_t sdu_len, off_t seg_offset,
			struct net_buf_simple *seg)
{
	uint32_t actions = 0;
	size_t used = 0;
	k_spinlock_key_t key;

	ARG_UNUSED(chan);
	ARG_UNUSED(sdu_len);
	ARG_UNUSED(seg_offset);

	key = k_spin_lock(&lock);
	if (credits_out > 0) {
		credits_out--;
	}

	while (used < seg->len && (actions & BLE_RELAY_DO_DROP) == 0) {
		struct ble_relay_item item;
		uint32_t more = 0;

		used += ble_relay_read(&reader, &seg->data[used], seg->len - used, &item);

		switch (item.kind) {
		case BLE_RELAY_ITEM_DATA:
			if (ble_relay_on_data(&session, &more) &&
			    ring_buf_put(&rx_ring, item.data, item.len) != item.len) {
				/* More than the credits allowed: the phone does not keep count. */
				more |= ble_relay_on_broken(&session);
			} else if ((more & BLE_RELAY_DO_DROP) == 0) {
				more |= BLE_RELAY_DO_WAKE;
			}
			break;
		case BLE_RELAY_ITEM_FRAME:
			more = ble_relay_on_frame(&session, item.type, item.data, item.len);
			break;
		case BLE_RELAY_ITEM_ERROR:
			more = ble_relay_on_broken(&session);
			break;
		default:
			break;
		}
		actions |= more;
	}
	k_spin_unlock(&lock, key);

	carry_out(actions, K_NO_WAIT);
	/* Bytes that were dropped or were frames take no room: their credits come back at once. */
	give_credits();
}

static const struct bt_l2cap_chan_ops chan_ops = {
	.connected = on_chan_connected,
	.disconnected = on_chan_disconnected,
	.seg_recv = on_seg_recv,
};

static int on_accept(struct bt_conn *conn, struct bt_l2cap_server *srv, struct bt_l2cap_chan **chan)
{
	k_spinlock_key_t key;
	uint16_t initial;

	ARG_UNUSED(conn);
	ARG_UNUSED(srv);

	/* Only the link that came for the relay, and one channel at a time. */
	if (!bt_ota_relay_link()) {
		return -EACCES;
	}
	if (atomic_get(&channel_open)) {
		return -ENOMEM;
	}

	memset(&relay_chan, 0, sizeof(relay_chan));
	relay_chan.chan.ops = &chan_ops;
	relay_chan.rx.mtu = RX_MTU;
	relay_chan.rx.mps = RX_MPS;

	key = k_spin_lock(&lock);
	ble_relay_reader_init(&reader, BLE_RELAY_PAYLOAD_MAX);
	/* What an ended stream left unread is gone: its socket reads the end. */
	ring_buf_reset(&rx_ring);
	initial = ble_relay_credits_due(ring_buf_space_get(&rx_ring), 0, RX_MPS);
	credits_out = initial;
	k_spin_unlock(&lock, key);

	/* Given before the accept is complete, these go in the response as its initial credits. */
	(void)bt_l2cap_chan_give_credits(&relay_chan.chan, initial);
	*chan = &relay_chan.chan;
	return 0;
}

static ssize_t read_psm(struct bt_conn *conn, const struct bt_gatt_attr *attr, void *buf, uint16_t len,
			uint16_t offset)
{
	uint8_t value[2];

	sys_put_le16(psm_value, value);
	return bt_gatt_attr_read(conn, attr, buf, len, offset, value, sizeof(value));
}

/* Readable with no pairing: the PSM is no secret, and the channel it names needs none (docs/ble-relay.md). */
BT_GATT_SERVICE_DEFINE(relay_service,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_DECLARE_128(BLE_RELAY_SERVICE_UUID_VAL)),
	BT_GATT_CHARACTERISTIC(BT_UUID_DECLARE_128(BLE_RELAY_PSM_UUID_VAL), BT_GATT_CHRC_READ,
			       BT_GATT_PERM_READ, read_psm, NULL, NULL),
);

/* ---- the relay socket: on whichever thread uses it ------------------------------------------- */

static bool readable_now(void)
{
	return !ring_buf_is_empty(&rx_ring) || session.state != BLE_RELAY_STREAMING;
}

static bool writable_now(void)
{
	return session.state != BLE_RELAY_STREAMING ||
	       atomic_get(&tx_busy) < CONFIG_APP_BLE_RELAY_TX_BUFFERS;
}

static ssize_t relay_recvfrom(void *obj, void *buf, size_t max_len, int flags,
			      struct net_sockaddr *src_addr, net_socklen_t *addrlen)
{
	ARG_UNUSED(obj);
	ARG_UNUSED(src_addr);
	ARG_UNUSED(addrlen);

	while (true) {
		struct k_poll_event event = K_POLL_EVENT_INITIALIZER(
			K_POLL_TYPE_SIGNAL, K_POLL_MODE_NOTIFY_ONLY, &readable);
		k_spinlock_key_t key;
		bool nonblock;
		uint32_t got;
		int err;
		enum ble_relay_state state;
		uint8_t reason;

		/* Reset before looking, so that what arrives after the look still wakes the wait. */
		k_poll_signal_reset(&readable);
		key = k_spin_lock(&lock);
		got = ring_buf_get(&rx_ring, buf, max_len);
		err = ble_relay_stream_error(&session);
		state = session.state;
		reason = session.reason;
		nonblock = sock.nonblock || (flags & ZSOCK_MSG_DONTWAIT) != 0;
		k_spin_unlock(&lock, key);

		if (got > 0) {
			give_credits();
			return (ssize_t)got;
		}

		if (state == BLE_RELAY_ENDED) {
			/* The server's end, or the board's own hand-back, read as an end; anything else is a reset. */
			if (reason == BLE_RELAY_REASON_NORMAL || reason == BLE_RELAY_REASON_PEER_CLOSED ||
			    reason == BLE_RELAY_REASON_HANDBACK) {
				return 0;
			}
			errno = ECONNRESET;
			return -1;
		}

		if (err != 0) {
			errno = -err;
			return -1;
		}

		if (nonblock) {
			errno = EAGAIN;
			return -1;
		}

		(void)k_poll(&event, 1, K_FOREVER);
	}
}

static ssize_t relay_sendto(void *obj, const void *data, size_t len, int flags,
			    const struct net_sockaddr *dest_addr, net_socklen_t addrlen)
{
	size_t chunk = MIN(len, TX_DATA);
	struct net_buf *buf;
	k_spinlock_key_t key;
	bool nonblock;
	int err;

	ARG_UNUSED(obj);
	ARG_UNUSED(dest_addr);
	ARG_UNUSED(addrlen);

	if (len == 0) {
		return 0;
	}

	while (true) {
		key = k_spin_lock(&lock);
		err = ble_relay_stream_error(&session);
		nonblock = sock.nonblock || (flags & ZSOCK_MSG_DONTWAIT) != 0;
		k_spin_unlock(&lock, key);

		if (err != 0) {
			errno = -err;
			return -1;
		}

		/* A blocking send looks at the stream again every half second: it may have ended meanwhile. */
		buf = tx_alloc(nonblock ? K_NO_WAIT : K_MSEC(500));
		if (buf != NULL) {
			break;
		}
		if (nonblock) {
			errno = EAGAIN;
			return -1;
		}
	}

	ble_relay_header(BLE_RELAY_DATA, (uint16_t)chunk, net_buf_add(buf, BLE_RELAY_HEADER_LEN));
	net_buf_add_mem(buf, data, chunk);
	if (tx_send(buf) < 0) {
		errno = ECONNRESET;
		return -1;
	}

	return (ssize_t)chunk;
}

static ssize_t relay_read(void *obj, void *buf, size_t len)
{
	return relay_recvfrom(obj, buf, len, 0, NULL, NULL);
}

static ssize_t relay_write(void *obj, const void *buf, size_t len)
{
	return relay_sendto(obj, buf, len, 0, NULL, 0);
}

/* Blocking, as the TLS layer always makes it: OPEN goes, and the phone answers with OPENED or CLOSE. */
static int relay_connect(void *obj, const struct net_sockaddr *addr, net_socklen_t addrlen)
{
	const struct net_sockaddr_in *in = (const struct net_sockaddr_in *)addr;
	uint8_t frame[BLE_RELAY_HEADER_LEN + 2 + BLE_RELAY_HOST_MAX];
	k_spinlock_key_t key;
	uint32_t actions;
	int len;
	int ret;

	ARG_UNUSED(obj);

	if (addrlen < sizeof(*in) || in->sin_family != NET_AF_INET ||
	    memcmp(in->sin_addr.s4_addr, relay_address, sizeof(relay_address)) != 0) {
		errno = ENETUNREACH;
		return -1;
	}

	len = ble_relay_open(route_host, net_ntohs(in->sin_port), frame, sizeof(frame));
	if (len < 0) {
		errno = EINVAL;
		return -1;
	}

	key = k_spin_lock(&lock);
	ret = ble_relay_on_connect(&session, k_uptime_get_32(), &actions);
	k_spin_unlock(&lock, key);
	if (ret != 0) {
		errno = -ret;
		return -1;
	}

	(void)k_sem_take(&changed, K_NO_WAIT);
	if (send_frame(frame, (size_t)len, K_SECONDS(2)) != 0) {
		key = k_spin_lock(&lock);
		actions = ble_relay_on_broken(&session);
		k_spin_unlock(&lock, key);
		carry_out(actions, K_NO_WAIT);
	}

	do {
		(void)k_sem_take(&changed, K_MSEC(500));
		key = k_spin_lock(&lock);
		actions = ble_relay_session_tick(&session, k_uptime_get_32());
		ret = ble_relay_connect_result(&session);
		k_spin_unlock(&lock, key);
		carry_out(actions, K_MSEC(100));
	} while (ret == -EINPROGRESS);

	if (ret != 0) {
		errno = -ret;
		return -1;
	}
	return 0;
}

static int relay_close(void *obj, int fd)
{
	k_spinlock_key_t key;
	uint32_t actions;

	ARG_UNUSED(obj);
	ARG_UNUSED(fd);

	key = k_spin_lock(&lock);
	actions = ble_relay_on_socket_closed(&session);
	ring_buf_reset(&rx_ring);
	sock.in_use = false;
	k_spin_unlock(&lock, key);

	carry_out(actions, K_MSEC(100));
	give_credits();
	return 0;
}

static int poll_prepare(struct zsock_pollfd *pfd, struct k_poll_event **pev,
			struct k_poll_event *pev_end)
{
	bool ready = false;
	k_spinlock_key_t key;

	if (pfd->events & ZSOCK_POLLIN) {
		if (*pev == pev_end) {
			return -ENOMEM;
		}
		k_poll_signal_reset(&readable);
		k_poll_event_init(*pev, K_POLL_TYPE_SIGNAL, K_POLL_MODE_NOTIFY_ONLY, &readable);
		(*pev)++;
		key = k_spin_lock(&lock);
		ready = readable_now();
		k_spin_unlock(&lock, key);
	}

	if (pfd->events & ZSOCK_POLLOUT) {
		if (*pev == pev_end) {
			return -ENOMEM;
		}
		k_poll_signal_reset(&writable);
		k_poll_event_init(*pev, K_POLL_TYPE_SIGNAL, K_POLL_MODE_NOTIFY_ONLY, &writable);
		(*pev)++;
		key = k_spin_lock(&lock);
		ready = ready || writable_now();
		k_spin_unlock(&lock, key);
	}

	return ready ? -EALREADY : 0;
}

static int poll_update(struct zsock_pollfd *pfd, struct k_poll_event **pev)
{
	k_spinlock_key_t key = k_spin_lock(&lock);

	if (pfd->events & ZSOCK_POLLIN) {
		if (readable_now()) {
			pfd->revents |= ZSOCK_POLLIN;
		}
		(*pev)++;
	}

	if (pfd->events & ZSOCK_POLLOUT) {
		if (writable_now()) {
			pfd->revents |= ZSOCK_POLLOUT;
		}
		(*pev)++;
	}

	if (session.state == BLE_RELAY_ENDED) {
		pfd->revents |= ZSOCK_POLLHUP;
	}
	k_spin_unlock(&lock, key);
	return 0;
}

static int relay_ioctl(void *obj, unsigned int request, va_list args)
{
	ARG_UNUSED(obj);

	switch (request) {
	case ZVFS_F_GETFL:
		return sock.nonblock ? ZVFS_O_NONBLOCK : 0;
	case ZVFS_F_SETFL:
		sock.nonblock = (va_arg(args, int) & ZVFS_O_NONBLOCK) != 0;
		return 0;
	case ZFD_IOCTL_FIONBIO:
		sock.nonblock = true;
		return 0;
	case ZFD_IOCTL_POLL_PREPARE: {
		struct zsock_pollfd *pfd = va_arg(args, struct zsock_pollfd *);
		struct k_poll_event **pev = va_arg(args, struct k_poll_event **);
		struct k_poll_event *pev_end = va_arg(args, struct k_poll_event *);

		return poll_prepare(pfd, pev, pev_end);
	}
	case ZFD_IOCTL_POLL_UPDATE: {
		struct zsock_pollfd *pfd = va_arg(args, struct zsock_pollfd *);
		struct k_poll_event **pev = va_arg(args, struct k_poll_event **);

		return poll_update(pfd, pev);
	}
	default:
		errno = EOPNOTSUPP;
		return -1;
	}
}

static int relay_getsockopt(void *obj, int level, int optname, void *optval, net_socklen_t *optlen)
{
	ARG_UNUSED(obj);

	if (level == ZSOCK_SOL_SOCKET && optname == ZSOCK_SO_ERROR && *optlen >= sizeof(int)) {
		k_spinlock_key_t key = k_spin_lock(&lock);
		int err = ble_relay_stream_error(&session);

		k_spin_unlock(&lock, key);
		*(int *)optval = -err;
		*optlen = sizeof(int);
		return 0;
	}

	errno = ENOPROTOOPT;
	return -1;
}

/* Time-outs and the like are taken and left alone: the TLS layer sends and reads without blocking. */
static int relay_setsockopt(void *obj, int level, int optname, const void *optval,
			    net_socklen_t optlen)
{
	ARG_UNUSED(obj);
	ARG_UNUSED(optname);
	ARG_UNUSED(optval);
	ARG_UNUSED(optlen);

	if (level == ZSOCK_SOL_SOCKET) {
		return 0;
	}

	errno = ENOPROTOOPT;
	return -1;
}

static int relay_shutdown(void *obj, int how)
{
	ARG_UNUSED(obj);
	ARG_UNUSED(how);
	return 0;
}

static int relay_name(void *obj, struct net_sockaddr *addr, net_socklen_t *addrlen)
{
	struct net_sockaddr_in *in = (struct net_sockaddr_in *)addr;

	ARG_UNUSED(obj);

	if (*addrlen < sizeof(*in)) {
		errno = EINVAL;
		return -1;
	}

	memset(in, 0, sizeof(*in));
	in->sin_family = NET_AF_INET;
	memcpy(in->sin_addr.s4_addr, relay_address, sizeof(relay_address));
	*addrlen = sizeof(*in);
	return 0;
}

static const struct socket_op_vtable relay_vtable = {
	.fd_vtable = {
		.read = relay_read,
		.write = relay_write,
		.close2 = relay_close,
		.ioctl = relay_ioctl,
	},
	.shutdown = relay_shutdown,
	.connect = relay_connect,
	.sendto = relay_sendto,
	.recvfrom = relay_recvfrom,
	.getsockopt = relay_getsockopt,
	.setsockopt = relay_setsockopt,
	.getpeername = relay_name,
	.getsockname = relay_name,
};

static bool relay_is_supported(int family, int type, int proto)
{
	return atomic_get(&routing) != 0 && family == NET_AF_INET && type == NET_SOCK_STREAM &&
	       proto == NET_IPPROTO_TCP;
}

static int relay_socket(int family, int type, int proto)
{
	k_spinlock_key_t key;
	int fd;

	ARG_UNUSED(family);
	ARG_UNUSED(type);
	ARG_UNUSED(proto);

	key = k_spin_lock(&lock);
	if (sock.in_use) {
		k_spin_unlock(&lock, key);
		errno = EBUSY;
		return -1;
	}
	sock.in_use = true;
	sock.nonblock = false;
	k_spin_unlock(&lock, key);

	fd = zvfs_reserve_fd();
	if (fd < 0) {
		key = k_spin_lock(&lock);
		sock.in_use = false;
		k_spin_unlock(&lock, key);
		return -1;
	}

	zvfs_finalize_typed_fd(fd, &sock, (const struct fd_op_vtable *)&relay_vtable, ZVFS_MODE_IFSOCK);
	return fd;
}

NET_SOCKET_REGISTER(ble_relay, 48, NET_AF_INET, relay_is_supported, relay_socket);

/* ---- the endpoint's name, while routing --------------------------------------------------------- */

/*
 * The one name the cloud connects to resolves to the relay's address; any other fails, so nothing else
 * goes over the relay by mistake. Allocated as the native resolver does, so that either one's
 * freeaddrinfo frees the other's: the hook goes on and off while other threads may hold a result.
 */
static int relay_getaddrinfo(const char *node, const char *service, const struct zsock_addrinfo *hints,
			     struct zsock_addrinfo **res)
{
	struct zsock_addrinfo *ai;
	struct net_sockaddr_in *in;

	ARG_UNUSED(service);

	if (atomic_get(&routing) == 0 || node == NULL || strcmp(node, route_host) != 0) {
		return DNS_EAI_NONAME;
	}

	if (hints != NULL && hints->ai_family != NET_AF_UNSPEC && hints->ai_family != NET_AF_INET) {
		return DNS_EAI_FAMILY;
	}

	ai = k_calloc(1, sizeof(*ai));
	if (ai == NULL) {
		return DNS_EAI_MEMORY;
	}

	in = (struct net_sockaddr_in *)&ai->_ai_addr;
	in->sin_family = NET_AF_INET;
	memcpy(in->sin_addr.s4_addr, relay_address, sizeof(relay_address));
	ai->ai_family = NET_AF_INET;
	ai->ai_socktype = NET_SOCK_STREAM;
	ai->ai_protocol = NET_IPPROTO_TCP;
	ai->ai_addr = (struct net_sockaddr *)in;
	ai->ai_addrlen = sizeof(*in);
	*res = ai;
	return 0;
}

static void relay_freeaddrinfo(struct zsock_addrinfo *res)
{
	k_free(res);
}

static const struct socket_dns_offload relay_dns = {
	.getaddrinfo = relay_getaddrinfo,
	.freeaddrinfo = relay_freeaddrinfo,
};

void ble_relay_route_begin(const char *host)
{
	strncpy(route_host, host, sizeof(route_host) - 1);
	route_host[sizeof(route_host) - 1] = '\0';
	(void)atomic_set(&routing, 1);
	socket_offload_dns_enable(true);
}

void ble_relay_route_end(void)
{
	socket_offload_dns_enable(false);
	(void)atomic_set(&routing, 0);
}

/* ---- the main loop ------------------------------------------------------------------------- */

int ble_relay_init(void)
{
	ble_relay_session_init(&session);
	ble_relay_offer_init(&offer);
	/* Registered once, and off until a connection goes over the relay. */
	socket_offload_dns_register(&relay_dns);
	socket_offload_dns_enable(false);
	return 0;
}

bool ble_relay_is_ready(void)
{
	return atomic_get(&channel_open) != 0;
}

static const char *state_text(enum ble_relay_state state)
{
	switch (state) {
	case BLE_RELAY_IDLE:
		return "channel open, no stream";
	case BLE_RELAY_OPENING:
		return "opening the connection to AWS IoT";
	case BLE_RELAY_STREAMING:
		return "relaying";
	case BLE_RELAY_ENDED:
		return "stream ended";
	default:
		return "no channel";
	}
}

bool ble_relay_on_tick(void)
{
	struct ble_relay_view view;
	enum ble_relay_state state;
	k_spinlock_key_t key;
	uint32_t actions;
	uint8_t reason;
	bool channel;
	bool handback = false;

	/* Bluetooth starts with the first window or offer: the server can be registered only after it. */
	if (!server_registered && bt_is_ready()) {
		server.psm = 0;
		server.sec_level = BT_SECURITY_L1;
		server.accept = on_accept;
		if (bt_l2cap_server_register(&server) == 0) {
			psm_value = server.psm;
			console_event("RELAY", "listening on PSM 0x%02x", psm_value);
		} else {
			console_event("RELAY", "the L2CAP server could not be registered");
		}
		server_registered = true;
	}

	view = (struct ble_relay_view){
		.provisioned = !device_is_factory() && identity_settings_get() != NULL,
		.window = bt_ota_radio_taken(),
		.wifi_up = net_is_up(),
		.channel = ble_relay_is_ready(),
		.cloud_up = cloud_is_connected(),
		.cloud_relayed = cloud_is_relayed(),
	};
	actions = ble_relay_offer_tick(&offer, &view);

	if (actions & BLE_RELAY_OFFER_START) {
		console_event("RELAY", "offered: no Wi-Fi for %d s", BLE_RELAY_OFFER_AFTER_SECONDS);
		bt_ota_relay_offer(true);
	}
	if (actions & BLE_RELAY_OFFER_STOP) {
		console_event("RELAY", "no longer offered");
		bt_ota_relay_offer(false);
	}
	if (actions & BLE_RELAY_HANDBACK) {
		key = k_spin_lock(&lock);
		actions = ble_relay_on_handback(&session);
		k_spin_unlock(&lock, key);
		carry_out(actions, K_MSEC(100));
		console_event("RELAY", "Wi-Fi is back: the cloud connection goes over it again");
		handback = true;
	}

	key = k_spin_lock(&lock);
	actions = ble_relay_session_tick(&session, k_uptime_get_32());
	state = session.state;
	reason = session.reason;
	channel = session.channel;
	k_spin_unlock(&lock, key);
	carry_out(actions, K_MSEC(100));

	if (state != said_state || channel != said_channel) {
		if (state == BLE_RELAY_ENDED) {
			console_event("RELAY", "%s (reason %u)", state_text(state), reason);
		} else {
			console_event("RELAY", "%s", state_text(state));
		}
		said_state = state;
		said_channel = channel;
	}

	return handback;
}
