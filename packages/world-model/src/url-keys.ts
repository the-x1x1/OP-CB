/**
 * Query parameters of `url` whose names are names a key goes under (the same names the logs
 * redact: `key`, `apikey`, `appid`, `token`, `subscription-key`, …). A definition file is
 * plain text, so a key there is a key on disk unencrypted: drafting moves it to the key store
 * and a definition saved from the app may not carry one.
 */
const KEY_PARAM_NAME =
  /^(?:key|api[_-]?key|app[_-]?(?:id|key)|token|access[_-]?token|auth[_-]?(?:key|token)?|map[_-]?key|subscription[_-]?key|ocp-apim-subscription-key|x-api-key|user[_-]?key|private[_-]?token|licen[sc]e[_-]?key|jwt|password|passwd|pwd|pass|secret|client[_-]?secret|sig|signature|session)$/i;
export function keyParamsIn(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url.replace('{TOKEN}', 'TOKEN'));
  } catch {
    return [];
  }
  return [...new Set([...u.searchParams.keys()].filter((k) => KEY_PARAM_NAME.test(k)))];
}
