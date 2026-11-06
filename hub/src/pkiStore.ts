import { settings } from './db.js';
import { certFingerprint, createPki, spkiPin } from './pki.js';
import { seal } from './secrets.js';
import { openSettings } from './storedSecrets.js';
import type { PkiDoc } from './types.js';

export interface Pki extends PkiDoc {
  // curl --pinnedpubkey of the agent TLS server
  serverPin: string;
  caFingerprint: string;
}

let cached: Pki | null = null;

// Loads the PKI, creating it on the first start of the hub.
export async function loadPki(): Promise<Pki> {
  if (cached) return cached;
  let doc = (await settings.findOne({ _id: 'pki' })) as PkiDoc | null;
  if (!doc) {
    const fresh = await createPki();
    // the private keys sealed with the master key (clear without key)
    const created: PkiDoc = { _id: 'pki', ...fresh, caKey: seal(fresh.caKey, 'settings/pki/caKey'), serverKey: seal(fresh.serverKey, 'settings/pki/serverKey') };
    // two hubs starting at once must end up with the same PKI
    await settings.updateOne({ _id: 'pki' }, { $setOnInsert: created }, { upsert: true });
    doc = (await settings.findOne({ _id: 'pki' })) as PkiDoc;
  }
  doc = openSettings('pki', doc)!;
  cached = { ...doc, serverPin: spkiPin(doc.serverCert), caFingerprint: certFingerprint(doc.caCert) };
  return cached;
}
