import { startAuthentication, startRegistration, WebAuthnError, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api, ApiError, tooManyAttemptsMessage } from './api';

// Browser side of the passkeys (hub/src/passkeys.ts): the dialog of the browser or of the password manager
// (Bitwarden…) creates the passkey or signs the challenge.

export async function registerPasskey(name: string) {
  const options = await api.passkeyOptions();
  return api.addPasskey(name, await startRegistration({ optionsJSON: options }));
}

export async function answerPasskey(ticket: string, options: PublicKeyCredentialRequestOptionsJSON) {
  return api.loginPasskey(ticket, await startAuthentication({ optionsJSON: options }));
}

// Before a sensitive action: the passkey proves the session again (hub/src/routes/passkeys.ts)
export async function proveSession() {
  const { ticket, options } = await api.reauthOptions();
  await api.reauth(ticket, await startAuthentication({ optionsJSON: options }));
}

const API_ERRORS: Record<string, string> = {
  passkey_refused: 'Passkey refusée.',
  passkey_expired: 'Délai dépassé : réessayez.',
  'no passkey': 'Aucune passkey enregistrée pour ce compte.',
  passkeys_disabled: 'Les passkeys ne sont pas activées sur ce hub (WEBAUTHN_RP_ID).',
  'last passkey': 'Les passkeys sont obligatoires pour les admins : la dernière ne peut pas être supprimée.',
};

export function passkeyErrorMessage(err: unknown) {
  if (err instanceof WebAuthnError) {
    if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'Cette passkey est déjà enregistrée pour ce compte.';
    if (err.code === 'ERROR_INVALID_DOMAIN' || err.code === 'ERROR_INVALID_RP_ID') return 'Adresse du hub différente de WEBAUTHN_RP_ID : ouvrez l’interface par son nom de domaine, en HTTPS.';
  }
  // dialog closed or timed out: the browser does not tell them apart
  if (err instanceof Error && err.name === 'NotAllowedError') return 'Opération annulée ou refusée par le navigateur.';
  if (err instanceof ApiError) return tooManyAttemptsMessage(err) ?? API_ERRORS[err.message] ?? err.message;
  return (err as Error).message;
}
