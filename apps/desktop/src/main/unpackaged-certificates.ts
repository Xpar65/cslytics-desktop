import { app, session } from 'electron';
import { CATALOGUE_HOST, IMAGE_HOSTS } from '@cslytics/catalogue';

/**
 * Lets an unpackaged run load names and art behind a filter that re-signs traffic with its own
 * certificate authority, which Chromium refuses as `net_error -202`. A packaged build returns at
 * once and checks every certificate the ordinary way: excusing a host there would let whoever can
 * intercept a user choose what that user's items are called, and later what they are worth.
 *
 * The catalogue host is accepted whatever its verdict, which also skips a revocation check that
 * such a filter leaves hanging until the sync times out; an image host only when its authority is
 * unknown. Every other host, the release host included, is checked as usual. `check:deps` allows a
 * verify proc in this file alone, and only while the packaged-build return is its first statement.
 */
export function trustInterceptedHostsUnpackaged(): void {
  if (app.isPackaged) return;
  const imageHosts = new Set(IMAGE_HOSTS);
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.hostname === CATALOGUE_HOST || (
      imageHosts.has(request.hostname)
      && (request.errorCode === -202 || request.verificationResult === 'net::ERR_CERT_AUTHORITY_INVALID')
    )) {
      callback(0);
      return;
    }
    callback(-3);
  });
}
