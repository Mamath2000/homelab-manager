// Page served over plain http from another machine than this one: the password and the session cookie go in clear.
// Browsers treat localhost as a secure context: Secure cookies work there over http.
export const insecureOrigin = () => location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

// same page on the TLS port of the UI (HTTPS_PORT)
export const onHttps = (httpsUrl: string) => `${httpsUrl}${location.pathname}${location.search}`;
