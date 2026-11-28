#include "factory.h"

#include <errno.h>

#include <zephyr/logging/log.h>
#if !defined(CONFIG_APP_BT_ONLY)
#include <zephyr/net/tls_credentials.h>
#endif

#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
#include "bt_passkey.h"
#endif
#include "device.h"
#include "identity.h"
#include "net.h"
#include "store.h"

LOG_MODULE_REGISTER(factory, CONFIG_APP_LOG_LEVEL);

#if defined(CONFIG_APP_BT_ONLY)
/* A board with Bluetooth only never connects to AWS IoT, and holds no certificate and no key for it. */
bool factory_has_root_ca(void)
{
	return false;
}

bool factory_has_certificate(void)
{
	return false;
}

bool factory_has_private_key(void)
{
	return false;
}
#else
static bool has_credential(sec_tag_t tag, enum tls_credential_type type)
{
	size_t length = 0;

	/* With a zero-length buffer nothing is copied; -EFBIG means it exists. */
	return tls_credential_get(tag, type, NULL, &length) != -ENOENT;
}

bool factory_has_root_ca(void)
{
	return has_credential(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE) &&
	       has_credential(FACTORY_DOWNLOAD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE);
}

bool factory_has_certificate(void)
{
	return has_credential(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PUBLIC_CERTIFICATE);
}

bool factory_has_private_key(void)
{
	return has_credential(FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PRIVATE_KEY);
}
#endif /* CONFIG_APP_BT_ONLY */

/* Keep going whatever happens, and remember the first thing that went wrong. */
static void note_error(int *first, int err)
{
	if (err != 0 && *first == 0) {
		*first = err;
	}
}

#if !defined(CONFIG_APP_BT_ONLY)
static void delete_credential(int *first, sec_tag_t tag, enum tls_credential_type type)
{
	int err = tls_credential_delete(tag, type);

	note_error(first, err == -ENOENT ? 0 : err);
}
#endif

int factory_reset(void)
{
	int first = 0;

	LOG_WRN("Factory reset: erasing all provisioned data");

	note_error(&first, device_wipe_begin());

#if !defined(CONFIG_APP_BT_ONLY)
	note_error(&first, net_credentials_clear());
#endif
	note_error(&first, identity_settings_clear());
	note_error(&first, store_erase(STORE_OTA_RECORD));
#if defined(CONFIG_APP_BT_OTA)
	note_error(&first, store_erase(STORE_BT_OTA_RECORD));
#endif
	note_error(&first, store_erase(STORE_STUCK));
	note_error(&first, store_erase(STORE_BOOT_DIARY));
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	/* The console keeps a copy for the phone: provisioning the board again replaces it. */
	note_error(&first, bt_passkey_erase());
#endif

#if !defined(CONFIG_APP_BT_ONLY)
	delete_credential(&first, FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PRIVATE_KEY);
	delete_credential(&first, FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_PUBLIC_CERTIFICATE);
	delete_credential(&first, FACTORY_CLOUD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE);
	delete_credential(&first, FACTORY_DOWNLOAD_SEC_TAG, TLS_CREDENTIAL_CA_CERTIFICATE);
#endif

	note_error(&first, device_wipe_end(first == 0));

	return first;
}
