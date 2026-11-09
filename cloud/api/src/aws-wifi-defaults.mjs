/**
 * The Wi-Fi network Board setup fills in by default (docs/new-board-setup.md, "The Wi-Fi defaults"): the secret
 * `<stack>/wifi-defaults` in Secrets Manager, JSON { ssid, passphrase, security }, stored by cloud/deploy.sh from
 * ~/.cranium/wifi_secrets.h. Only the API function may read it (template.yaml ReadWifiDefaults), and only
 * GET /api/setup/wifi-defaults asks for it (handlers/setup.mjs).
 *
 * wifiDefaults() is the secret's text, or null when the stack has none stored (the secret as the stack makes
 * it has no value). Any other failure throws an error named WifiDefaultsError, which says only the AWS error's
 * name: never the value. The value is not kept between requests either: each read asks Secrets Manager.
 *
 * The SDK is loaded only in Lambda; the tests pass readSecret.
 */

const ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z]{2}(?:-[a-z]+)+-\d{1,2}:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/;

export class WifiDefaultsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WifiDefaultsError';
  }
}

const nameOf = (error) => (typeof error?.name === 'string' ? error.name.slice(0, 64) : 'Error');

function secretsManagerReader(region, arn) {
  let client = null;
  let sdk = null;
  return async () => {
    sdk ??= await import('@aws-sdk/client-secrets-manager');
    client ??= new sdk.SecretsManagerClient({
      region,
      maxAttempts: 2,
      requestHandler: {
        connectionTimeout: 1000,
        socketTimeout: 3000,
        requestTimeout: 4000,
        throwOnRequestTimeout: true,
      },
    });
    try {
      const out = await client.send(new sdk.GetSecretValueCommand({ SecretId: arn }));
      return typeof out?.SecretString === 'string' ? out.SecretString : null;
    } catch (cause) {
      if (nameOf(cause) === 'ResourceNotFoundException') return null;
      throw new WifiDefaultsError(`GetSecretValue: ${nameOf(cause)}`);
    }
  };
}

/**
 * @param {Record<string, string|undefined>} env  the API function's environment: WIFI_DEFAULTS_SECRET_ARN
 * @param {object} [options]
 * @param {() => Promise<string|null>} [options.readSecret]  the secret's value, or null
 */
export function createWifiDefaultsReader(env, { readSecret } = {}) {
  const arn = env?.WIFI_DEFAULTS_SECRET_ARN ?? '';
  const read = readSecret ?? (ARN.test(arn) ? secretsManagerReader(env?.AWS_REGION, arn) : null);
  return {
    async wifiDefaults() {
      if (read === null) return null;
      try {
        return await read();
      } catch (cause) {
        if (cause instanceof WifiDefaultsError) throw cause;
        throw new WifiDefaultsError(`GetSecretValue: ${nameOf(cause)}`);
      }
    },
  };
}
