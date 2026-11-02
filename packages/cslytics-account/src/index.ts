/**
 * The CSlytics account on this desktop: a browser sign-in to the CSlytics website, the account it
 * reports, and the tokens that keep it. What each feature unlocks is the desktop's
 * (`apps/desktop/src/shared/command-access.ts`). Composed by main; the engine never imports it
 * (`check:deps`), and the window sees only `CslyticsStatus`, over IPC.
 */
export {
  CslyticsAccount, REFRESH_TOKEN_KEY, SIGN_IN_TIMEOUT_MS,
  type BearerAnswer, type CslyticsAccountOptions, type CslyticsAccountState, type CslyticsStatus, type SignInProblem
} from './account.js';
export { AccountFile, type AccountFileIo, type StoredAccount } from './account-file.js';
export {
  HttpAccountIssuer, parseAccount, parseTokens,
  type AccountIssuer, type AccountRecord, type FetchInit, type FetchLike, type IssuerAnswer, type TokenSet
} from './issuer.js';
export {
  CallbackGate, openLoopbackListener,
  type CallbackListener, type CallbackOutcome, type CallbackReply, type CallbackRequest, type OpenListener
} from './loopback.js';
export { OracleAccountIssuer, type OracleUser } from './oracle.js';
export { codeChallenge, randomToken } from './pkce.js';
export {
  AUTHORIZE_PATH, CSLYTICS_WEBSITE_ORIGIN, DESKTOP_CLIENT_ID, deviceLabel, isAllowedBrowserUrl, landingUrls, websiteOrigin,
  type Landing
} from './website.js';
