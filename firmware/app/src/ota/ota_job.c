#include "ota_job.h"

#include <ctype.h>
#include <math.h>
#include <string.h>

#include <cJSON.h>

#define JSON_MAX_DEPTH 6
#define URL_SCHEME     "https://"

/*
 * The JSON parser recurses once per nesting level. Reject deeply nested input before
 * it reaches the parser, so that a hostile message cannot exhaust the stack.
 */
static bool depth_within_limit(const char *json, size_t len)
{
	int depth = 0;
	bool in_string = false;
	bool escaped = false;

	for (size_t i = 0; i < len; i++) {
		char c = json[i];

		if (in_string) {
			if (escaped) {
				escaped = false;
			} else if (c == '\\') {
				escaped = true;
			} else if (c == '"') {
				in_string = false;
			}
			continue;
		}

		if (c == '"') {
			in_string = true;
		} else if (c == '{' || c == '[') {
			if (++depth > JSON_MAX_DEPTH) {
				return false;
			}
		} else if (c == '}' || c == ']') {
			depth--;
		}
	}

	return true;
}

static const char *string_member(const cJSON *object, const char *name)
{
	const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, name);

	return cJSON_IsString(item) ? item->valuestring : NULL;
}

/* A JSON number that is a whole value between min and max. */
static bool integer_member(const cJSON *object, const char *name, double min, double max,
			   uint32_t *out)
{
	const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, name);
	double value;

	if (!cJSON_IsNumber(item)) {
		return false;
	}

	value = item->valuedouble;
	if (!(value >= min && value <= max) || floor(value) != value) {
		return false;
	}

	*out = (uint32_t)value;
	return true;
}

static bool copy_job_id(const char *text, char *out)
{
	size_t length;

	if (text == NULL) {
		return false;
	}

	length = strlen(text);
	if (length == 0 || length > OTA_JOB_ID_MAX) {
		return false;
	}

	/* The characters AWS IoT allows in a job ID. The ID is later put into an MQTT
	 * topic, so nothing else may get through.
	 */
	for (size_t i = 0; i < length; i++) {
		char c = text[i];

		if (!isalnum((unsigned char)c) && c != '-' && c != '_') {
			return false;
		}
	}

	memcpy(out, text, length + 1);
	return true;
}

static int hex_value(char c)
{
	if (c >= '0' && c <= '9') {
		return c - '0';
	}

	if (c >= 'a' && c <= 'f') {
		return c - 'a' + 10;
	}

	return -1;
}

static bool parse_hex(const char *text, uint8_t *out, size_t size)
{
	if (text == NULL || strlen(text) != 2 * size) {
		return false;
	}

	for (size_t i = 0; i < size; i++) {
		int high = hex_value(text[2 * i]);
		int low = hex_value(text[2 * i + 1]);

		if (high < 0 || low < 0) {
			return false;
		}

		out[i] = (uint8_t)((high << 4) | low);
	}

	return true;
}

static bool parse_sha256(const char *text, uint8_t *out)
{
	return parse_hex(text, out, OTA_SHA256_SIZE);
}

#if defined(CONFIG_APP_PI_OTA)
/* A Pi image's version: it goes into the signed manifest (pi_image.h), so nothing that breaks a line. */
static bool copy_pi_version(const char *text, char *out)
{
	size_t length;

	if (text == NULL) {
		return false;
	}

	length = strlen(text);
	if (length == 0 || length > OTA_PI_VERSION_MAX) {
		return false;
	}

	for (size_t i = 0; i < length; i++) {
		char c = text[i];

		if (!isalnum((unsigned char)c) && c != '.' && c != '-' && c != '_' && c != '+') {
			return false;
		}
	}

	memcpy(out, text, length + 1);
	return true;
}

#endif /* CONFIG_APP_PI_OTA */

/*
 * Accept a URL only if it starts with the provisioned prefix, then split it into the
 * two parts the download client takes. The prefix ends inside the path, so the host
 * is fixed by it and cannot be changed by the rest of the URL.
 */
static enum ota_job_result split_url(const char *url, const char *allowed_prefix,
				     struct ota_job *job)
{
	size_t url_length;
	size_t prefix_length;
	const char *host_start;
	const char *host_end;
	const char *file;
	size_t host_length;
	size_t file_length;

	if (url == NULL || allowed_prefix == NULL) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	url_length = strlen(url);
	prefix_length = strlen(allowed_prefix);

	if (url_length > OTA_JOB_HOST_MAX + 1 + OTA_JOB_FILE_MAX) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	for (size_t i = 0; i < url_length; i++) {
		if (!isgraph((unsigned char)url[i])) {
			return OTA_JOB_BAD_DOCUMENT;
		}
	}

	if (prefix_length <= strlen(URL_SCHEME) ||
	    strncmp(allowed_prefix, URL_SCHEME, strlen(URL_SCHEME)) != 0 ||
	    strchr(allowed_prefix + strlen(URL_SCHEME), '/') == NULL) {
		/* Without a usable prefix nothing may be downloaded. */
		return OTA_JOB_URL_NOT_ALLOWED;
	}

	if (url_length <= prefix_length || strncmp(url, allowed_prefix, prefix_length) != 0) {
		return OTA_JOB_URL_NOT_ALLOWED;
	}

	host_start = url + strlen(URL_SCHEME);
	host_end = strchr(host_start, '/');
	host_length = (size_t)(host_end - host_start);
	file = host_end + 1;
	file_length = strlen(file);

	if (host_length == 0 || host_length > 255 || file_length == 0 ||
	    file_length > OTA_JOB_FILE_MAX) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	for (size_t i = 0; i < host_length; i++) {
		char c = host_start[i];

		/* No port, no user information, no IPv6 literal. */
		if (!isalnum((unsigned char)c) && c != '.' && c != '-') {
			return OTA_JOB_BAD_DOCUMENT;
		}
	}

	/*
	 * The download client's URL parser treats a colon as a port separator and "//"
	 * as a scheme separator wherever they appear, and a fragment makes no sense in a
	 * request. Presigned URLs percent-encode all of these.
	 */
	if (strchr(file, ':') != NULL || strchr(file, '#') != NULL || strstr(file, "//") != NULL) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	memcpy(job->host, url, strlen(URL_SCHEME) + host_length);
	job->host[strlen(URL_SCHEME) + host_length] = '\0';
	memcpy(job->file, file, file_length + 1);

	return OTA_JOB_OK;
}

#if defined(CONFIG_APP_PI_OTA)
/* The "pi" object of a Pi image's job or of a job with both: everything but its URL. */
static enum ota_job_result parse_pi_part(const cJSON *image, struct ota_job *job)
{
	if (!cJSON_IsObject(image)) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	if (!copy_pi_version(string_member(image, "version"), job->pi_version) ||
	    !integer_member(image, "size", 1, UINT32_MAX, &job->pi_size) ||
	    !parse_sha256(string_member(image, "sha256"), job->pi_sha256) ||
	    !parse_hex(string_member(image, "sig"), job->pi_sig, OTA_PI_SIG_SIZE)) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	/* Optional, and if it is there it has to be a version. */
	if (cJSON_GetObjectItemCaseSensitive(image, "minFirmware") != NULL) {
		if (fw_version_parse(string_member(image, "minFirmware"), &job->pi_min_firmware) !=
		    0) {
			return OTA_JOB_BAD_DOCUMENT;
		}
		job->pi_has_min_firmware = true;
	}

	return OTA_JOB_OK;
}

#endif /* CONFIG_APP_PI_OTA */

/* The "fw" object of a firmware job or of a job with both: everything but its URL. */
static enum ota_job_result parse_firmware_part(const cJSON *firmware, struct ota_job *job)
{
	if (!cJSON_IsObject(firmware)) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	if (fw_version_parse(string_member(firmware, "version"), &job->version) != 0 ||
	    !integer_member(firmware, "size", 1, UINT32_MAX, &job->size) ||
	    !parse_sha256(string_member(firmware, "sha256"), job->sha256)) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	return OTA_JOB_OK;
}

#if defined(CONFIG_APP_PI_OTA)
static enum ota_job_result parse_pi_document(const cJSON *document, const char *allowed_url_prefix,
					     struct ota_job *job)
{
	const cJSON *image = cJSON_GetObjectItemCaseSensitive(document, "pi");
	enum ota_job_result result;

	job->kind = OTA_JOB_KIND_PI_IMAGE;
	result = parse_pi_part(image, job);
	if (result != OTA_JOB_OK) {
		return result;
	}

	/* A job with a Pi image only: its size and digest are the job's, as they always were. */
	job->size = job->pi_size;
	memcpy(job->sha256, job->pi_sha256, OTA_SHA256_SIZE);
	return split_url(string_member(image, "url"), allowed_url_prefix, job);
}

/*
 * Firmware and a Pi image. Both URLs must pass; the one of the part that is not wanted is checked
 * first, so that the wanted one is what stays in host and file.
 */
static enum ota_job_result parse_bundle_document(const cJSON *document,
						 const char *allowed_url_prefix,
						 enum ota_job_part part, struct ota_job *job)
{
	const cJSON *firmware = cJSON_GetObjectItemCaseSensitive(document, "fw");
	const cJSON *image = cJSON_GetObjectItemCaseSensitive(document, "pi");
	const char *wanted;
	const char *other;
	enum ota_job_result result;

	job->kind = OTA_JOB_KIND_BUNDLE;
	result = parse_firmware_part(firmware, job);
	if (result == OTA_JOB_OK) {
		result = parse_pi_part(image, job);
	}
	if (result != OTA_JOB_OK) {
		return result;
	}

	wanted = string_member(part == OTA_JOB_PART_PI ? image : firmware, "url");
	other = string_member(part == OTA_JOB_PART_PI ? firmware : image, "url");
	result = split_url(other, allowed_url_prefix, job);
	return result == OTA_JOB_OK ? split_url(wanted, allowed_url_prefix, job) : result;
}

#endif /* CONFIG_APP_PI_OTA */

static enum ota_job_result parse_document(const cJSON *document, const char *allowed_url_prefix,
					  enum ota_job_part part, struct ota_job *job)
{
	const cJSON *firmware;
	const char *operation;
	uint32_t document_version;
	enum ota_job_result result;

	if (!cJSON_IsObject(document)) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	operation = string_member(document, "op");
	if (operation == NULL || !integer_member(document, "v", 1, 1, &document_version)) {
		return OTA_JOB_UNSUPPORTED;
	}

#if defined(CONFIG_APP_PI_OTA)
	if (strcmp(operation, "pi_image") == 0) {
		return parse_pi_document(document, allowed_url_prefix, job);
	}

	if (strcmp(operation, "fw_pi_update") == 0) {
		return parse_bundle_document(document, allowed_url_prefix, part, job);
	}
#else
	/* "pi_image" and "fw_pi_update" are for a Pi build: here they are unsupported, as below. */
	(void)part;
#endif

	if (strcmp(operation, "fw_update") != 0) {
		return OTA_JOB_UNSUPPORTED;
	}

	firmware = cJSON_GetObjectItemCaseSensitive(document, "fw");
	result = parse_firmware_part(firmware, job);
	if (result != OTA_JOB_OK) {
		return result;
	}

	return split_url(string_member(firmware, "url"), allowed_url_prefix, job);
}

/*
 * The MQTT interface embeds the job document as an object. Other AWS IoT interfaces
 * deliver the same document as a string of JSON; accept that form too.
 */
static enum ota_job_result parse_execution_document(const cJSON *execution,
						    const char *allowed_url_prefix,
						    enum ota_job_part part, struct ota_job *job)
{
	const cJSON *document = cJSON_GetObjectItemCaseSensitive(execution, "jobDocument");
	enum ota_job_result result;
	cJSON *embedded;

	if (!cJSON_IsString(document)) {
		return parse_document(document, allowed_url_prefix, part, job);
	}

	if (!depth_within_limit(document->valuestring, strlen(document->valuestring))) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	embedded = cJSON_Parse(document->valuestring);
	result = parse_document(embedded, allowed_url_prefix, part, job);
	cJSON_Delete(embedded);
	return result;
}

enum ota_job_result ota_job_parse(const char *json, size_t len, const char *allowed_url_prefix,
				  struct ota_job *job)
{
	return ota_job_parse_part(json, len, allowed_url_prefix, OTA_JOB_PART_FIRMWARE, job);
}

enum ota_job_result ota_job_parse_part(const char *json, size_t len, const char *allowed_url_prefix,
				       enum ota_job_part part, struct ota_job *job)
{
	enum ota_job_result result;
	const cJSON *execution;
	const char *status;
	cJSON *root;

	if (json == NULL || job == NULL) {
		return OTA_JOB_MALFORMED;
	}

	memset(job, 0, sizeof(*job));

	if (!depth_within_limit(json, len)) {
		return OTA_JOB_MALFORMED;
	}

	root = cJSON_ParseWithLength(json, len);
	if (!cJSON_IsObject(root)) {
		cJSON_Delete(root);
		return OTA_JOB_MALFORMED;
	}

	execution = cJSON_GetObjectItemCaseSensitive(root, "execution");
	if (execution == NULL) {
		cJSON_Delete(root);
		return OTA_JOB_NONE;
	}

	if (!cJSON_IsObject(execution) || !copy_job_id(string_member(execution, "jobId"), job->id)) {
		cJSON_Delete(root);
		memset(job, 0, sizeof(*job));
		return OTA_JOB_MALFORMED;
	}

	status = string_member(execution, "status");
	job->in_progress = (status != NULL) && strcmp(status, "IN_PROGRESS") == 0;

	result = parse_execution_document(execution, allowed_url_prefix, part, job);
	cJSON_Delete(root);

	if (result != OTA_JOB_OK) {
		/* Leave only what identifies the execution, so that the caller can refuse it. */
		char id[OTA_JOB_ID_MAX + 1];
		bool in_progress = job->in_progress;

		memcpy(id, job->id, sizeof(id));
		memset(job, 0, sizeof(*job));
		memcpy(job->id, id, sizeof(id));
		job->in_progress = in_progress;
	}

	return result;
}

/* The first job in a list of summaries that is not a Pi image's, by its ID. */
static bool first_firmware_job(const cJSON *list, struct ota_job *job)
{
	const cJSON *entry;

	if (list == NULL) {
		return false;
	}

	cJSON_ArrayForEach(entry, list) {
		const char *id = string_member(entry, "jobId");

		if (id == NULL ||
		    strncmp(id, OTA_PI_JOB_ID_PREFIX, strlen(OTA_PI_JOB_ID_PREFIX)) == 0) {
			continue;
		}

		if (copy_job_id(id, job->id)) {
			return true;
		}
	}

	return false;
}

enum ota_job_result ota_job_list_parse(const char *json, size_t len, struct ota_job *job)
{
	const cJSON *in_progress;
	const cJSON *queued;
	enum ota_job_result result = OTA_JOB_NONE;
	cJSON *root;

	if (json == NULL || job == NULL) {
		return OTA_JOB_MALFORMED;
	}

	memset(job, 0, sizeof(*job));

	if (!depth_within_limit(json, len)) {
		return OTA_JOB_MALFORMED;
	}

	root = cJSON_ParseWithLength(json, len);
	in_progress = cJSON_GetObjectItemCaseSensitive(root, "inProgressJobs");
	queued = cJSON_GetObjectItemCaseSensitive(root, "queuedJobs");
	if (!cJSON_IsObject(root) || (in_progress != NULL && !cJSON_IsArray(in_progress)) ||
	    (queued != NULL && !cJSON_IsArray(queued))) {
		cJSON_Delete(root);
		return OTA_JOB_MALFORMED;
	}

	if (first_firmware_job(in_progress, job)) {
		job->in_progress = true;
		result = OTA_JOB_OK;
	} else if (first_firmware_job(queued, job)) {
		result = OTA_JOB_OK;
	}

	cJSON_Delete(root);
	return result;
}

enum ota_job_result ota_job_check(const struct ota_job *job, const struct fw_version *running,
				  size_t slot_size)
{
	/* Equal versions are refused too: re-sending an old job must not do anything. */
	if (fw_version_compare(&job->version, running) <= 0) {
		return OTA_JOB_NOT_NEWER;
	}

	if (job->size > slot_size) {
		return OTA_JOB_TOO_LARGE;
	}

	return OTA_JOB_OK;
}

const char *ota_job_result_reason(enum ota_job_result result)
{
	switch (result) {
	case OTA_JOB_OK:
		return "ok";
	case OTA_JOB_NONE:
		return "no_job";
	case OTA_JOB_UNSUPPORTED:
		return "unsupported";
	case OTA_JOB_URL_NOT_ALLOWED:
		return "url_not_allowed";
	case OTA_JOB_NOT_NEWER:
		return "not_newer";
	case OTA_JOB_TOO_LARGE:
		return "too_large";
	case OTA_JOB_MALFORMED:
	case OTA_JOB_BAD_DOCUMENT:
	default:
		return "bad_document";
	}
}
