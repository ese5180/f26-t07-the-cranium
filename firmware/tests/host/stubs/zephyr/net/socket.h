/*
 * Host build: the BSD-style sockets src/pi/pi_delta_ota.c fetches a Pi update with. Declared only:
 * a test that compiles it defines them, and so decides what the network does.
 */
#ifndef HOST_STUB_SOCKET_H_
#define HOST_STUB_SOCKET_H_

#include <stddef.h>
#include <sys/types.h>

#define NET_AF_INET                    1
#define NET_SOCK_STREAM                1
#define NET_IPPROTO_TLS_1_2            258
#define ZSOCK_SOL_SOCKET               1
#define ZSOCK_SOL_TLS                  282
#define ZSOCK_SO_RCVTIMEO              20
#define ZSOCK_SO_SNDTIMEO              21
#define ZSOCK_TLS_SEC_TAG_LIST         1
#define ZSOCK_TLS_HOSTNAME             2
#define ZSOCK_TLS_PEER_VERIFY          5
#define ZSOCK_TLS_PEER_VERIFY_REQUIRED 2

struct net_sockaddr;

struct zsock_timeval {
	long tv_sec;
	long tv_usec;
};

struct zsock_addrinfo {
	int ai_family;
	int ai_socktype;
	struct net_sockaddr *ai_addr;
	int ai_addrlen;
	struct zsock_addrinfo *ai_next;
};

int zsock_getaddrinfo(const char *host, const char *service, const struct zsock_addrinfo *hints,
		      struct zsock_addrinfo **res);
void zsock_freeaddrinfo(struct zsock_addrinfo *ai);
int zsock_socket(int family, int type, int proto);
int zsock_setsockopt(int sock, int level, int optname, const void *optval, size_t optlen);
int zsock_connect(int sock, const struct net_sockaddr *addr, int addrlen);
ssize_t zsock_send(int sock, const void *buf, size_t len, int flags);
ssize_t zsock_recv(int sock, void *buf, size_t max_len, int flags);
int zsock_close(int sock);

#endif
