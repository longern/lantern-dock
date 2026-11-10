export default {
  sessionExpired:
    "The site session may have expired. Check your account again before retrying NAS permissions.",
  sessionOffline: "You are offline",
  sessionOfflineHint:
    "Reconnect to check your account. Public browsing does not require sign-in.",
  nasOffline:
    "You are offline. Your site sign-in has not changed; NAS permissions could not be checked.",
  nasPermissionDenied:
    "The NAS did not authorize this account. Your site sign-in has not changed.",
  nasNotConfigured:
    "The NAS is not configured. Your site account is still signed in.",
  retryNAS: "Check NAS permissions again",

  closeSignIn: "Close sign-in",
  signInFailed: "Could not start sign-in. Try again.",
  guest: "Guest",
  sessionUnavailable: "Account unavailable",
  sessionRetryHint: "Could not check your sign-in status. Try again.",
  subjectCopied: "Copied sub.",
  administratorCopied: "Copied administrator configuration.",
  administratorInstructions:
    "Set the NAS service’s ADMIN_SUBJECTS environment variable to the value below. For multiple administrators, separate their site subjects with commas. Recreate the NAS container with the updated environment, then select “Check again”.",
  webhookSavedInstructions:
    "Set the bridge’s CERT_WEBHOOK_URL to the Webhook URL saved when the key was first generated.",
  webhookExistingInstructions:
    "Keep the same deployed SECRET_KEY in your local project’s .env file, then run the following command:",
  webhookBridgeInstructions:
    "Set the gateway’s CERT_WEBHOOK_URL to this URL and enable --auto-cert.",
  webhookSaveInstructions:
    "Save this alongside the matching site configuration. Name the Worker’s KV binding KV.",
  kvBindingInstructions: "Name the Worker’s KV binding KV.",
  certificateBridgeInstructions:
    "Merge the saved bridge.env into your gateway configuration and enable --auto-cert.",
  missingKvInstructions:
    "No KV binding was detected. In the Worker’s Bindings, select an existing KV namespace, set the variable name to KV, then save and deploy. Renaming a namespace alone does not create a binding.",
  localCertificateInstructions:
    "For local development, you can also set CERTIFICATES_JSON in .env and restart the service.",
  localExportInstructions:
    "Merge this into your project’s .env file, then restart the development server.",
  workerExportInstructions:
    "Paste this into “Variables and Secrets” in the dashboard, mark SECRET_KEY as a Secret, then deploy.",
  webdavRequirements:
    "WebDAV must support PROPFIND, GET, and HEAD, and CORS must allow {{origin}}.",
  gatewayRequirements:
    "The gateway must allow {{origin}}, accept UDP traffic, and allow GET, HEAD, and PROPFIND.",
  localCertificateRequirements:
    "For local development, set CERTIFICATES_JSON in .env.",
  workerCertificateRequirements:
    "Name the Worker’s KV binding KV and enable --auto-cert on the bridge to publish certificates.",
  uploadProgress: "Upload progress for {{name}}",
  uploadBytes: "{{loaded}} / {{total}}",
  identityMismatch:
    "The account identity does not match. Sign out and sign in again.",
  copyFailed: "Could not copy. Select the text and copy it manually.",
  myAccount: "My account",
  signedIn: "Signed in",
  signInTitle: "Sign in to your account",
  signInDescription:
    "Browse public files without signing in. Sign in to view your account details.",
  checkingAccount: "Checking your account…",
  email: "Email",
  siteRole: "Site role",
  administrator: "Administrator",
  standardUser: "Standard user",
  verificationUnavailable: "Verification unavailable",
  verifying: "Verifying…",
  accountDetails: "Account details",
  identityIssuer: "Identity issuer",
  userSubject: "User identifier (sub)",
  copySubject: "Copy sub",
  administratorMissing: "No administrator configured",
  administratorValue: "ADMIN_SUBJECTS value",
  copyAdministrator: "Copy administrator configuration",
  administratorEnabled: "Administrator access is enabled.",
  redirectingToSignIn: "Opening sign-in…",
  signIn: "Sign in",
  signOut: "Sign out",
  checkAgain: "Check again",
  backToPublicFiles: "Back to public files",
  webhookGenerationFailed:
    "Cannot generate the URL in this browser. Use an HTTPS page or run npm run webhook locally.",
  webhookCopied: "Copied the certificate update Webhook URL.",
  webhookCopyManually: "Copy the selected Webhook URL.",
  certificateWebhook: "Certificate update Webhook",
  recalculateWebhook: "Recalculate the URL with an existing key",
  bridgeConfiguration: "Bridge configuration",
  deploymentAddress: "LanternDock deployment address",
  webhookAddressInvalid:
    "Enter an HTTPS site address without a path, query parameters, or credentials.",
  webhookAddressHelp: "Enter your LanternDock site address.",
  certificateWebhookUrl: "Certificate update Webhook URL",
  webhookUrlPlaceholder: "Generated after you enter the site address",
  hideWebhookUrl: "Hide Webhook URL",
  showWebhookUrl: "Show Webhook URL",
  copyWebhookUrl: "Copy Webhook URL",
  downloadBridgeEnv: "Download bridge.env",
  savedConnectionAddress: "Saved connection address",
  kvConnected: "KV storage is connected.",
  checkCertificateInstructions:
    "After the gateway publishes its certificate, select “Check again” below.",
  connectionMethod: "Connection method",
  directConnection: "Connect directly to your file server",
  bridgeConnection: "Connect through a bridge gateway",
  webtransportAddress: "WebTransport gateway address",
  webdavAddress: "WebDAV service address",
  webtransportAddressHelp:
    "Enter the full gateway address ending in /webtransport.",
  webdavAddressHelp:
    "Enter the service address. The default root is /dav/; a full WebDAV address lets us detect the root automatically.",
  advancedSettings: "Advanced settings",
  resourceName: "Resource name",
  webdavRoot: "WebDAV root directory",
  webtransportRootPlaceholder: "/dav/ (default)",
  webdavRootPlaceholder: "Auto-detected; defaults to /dav/",
  backendAuthentication: "Backend authentication",
  noAuthentication: "No authentication",
  basicAuthentication: "Username and password (Basic)",
  bearerAuthentication: "Access token (Bearer)",
  gatewayCertificate: "Gateway certificate",
  pinnedCertificate: "Short-lived certificate + automatic renewal",
  trustedCertificate: "Publicly trusted HTTPS certificate",
  gatewayRequiresToken: "Gateway requires an access token",
  credentialsHelp: "Enter your credentials and access tokens when connecting.",
  generateConfiguration: "Generate configuration",
  configurationCopied: "Copied configuration.",
  configurationCopyManually: "Copy the selected configuration text.",
  deploymentEnvironment: "Deployment environment",
  localDevelopment: "Local development",
  deploymentAddressInvalid:
    "Enter an HTTPS site address without a path or query parameters.",
  siteConfiguration: "Site configuration",
  lanternDockConfiguration: "LanternDock configuration",
  hideKey: "Hide key",
  showKey: "Show key",
  downloadConfiguration: "Download configuration",
  copyConfiguration: "Copy configuration",
  generatedConfiguration: "Generated configuration",
  newKeyHelp:
    "A random key has been generated. Copying and downloading include the full value, so save your configuration.",
  existingKeyHelp:
    "Keep the site’s existing SECRET_KEY. This export will not replace it.",
  otherDeploymentMethods: "Other deployment methods",
  wranglerSecretsHelp:
    "Wrangler vars contain only ordinary variables. Set the key separately as a Worker Secret.",
  wranglerConfiguration: "Wrangler configuration",
  downloadWranglerJson: "Download Wrangler JSON",
  generateDeploymentKey: "Generate a key for a new deployment",
  connectionTroubleshooting: "Connection requirements and troubleshooting",
  missingBackendReason:
    "Enter your file service address to generate a deployment configuration.",
  invalidConfigurationReason:
    "Check and complete the backend connection details.",
  conflictingBackendsReason:
    "Two connection addresses were detected. Choose the one you want to keep.",
  connectBackend: "Connect backend",
  connectCertificates: "Connect certificates",
  saveAndDeploy: "Save and deploy",
  waitingForCertificate:
    "The site configuration is saved. Waiting for the gateway to publish its certificate.",
  saveDeploymentDescription:
    "Save the configuration, apply it to your deployment, then check again.",
  setupEyebrow: "Set up LanternDock",
  setupTitle: "Connect your file space",
  setupSteps: "Setup steps",
  configureGatewayCertificates: "Configure gateway certificates",
  missingCertificates:
    "No valid gateway certificate was detected. Check that the gateway has published it.",
  missingBackendConfiguration:
    "No valid backend configuration was detected. Apply the configuration and restart or redeploy.",
  editConnection: "Edit connection",
  previousStep: "Back",
  openDeployedSite: "Open deployed site",
  checking: "Checking…",
  configurationDocumentation: "Configuration documentation",
  tryDemo: "Try the demo",
  invalidUploadLink:
    "This upload link is invalid. Ask the recipient for the complete link.",
  uploadServiceUnavailable:
    "This site is not connected to an upload service. Ask the recipient to finish setup.",
  temporaryInbox: "Temporary inbox",
  receiveFiles: "Receive files",
  uploadPrivacy: "Only the recipient can view your files.",
  connectingInbox: "Connecting to the inbox…",
  fileSizeLimit: "Maximum file size",
  remainingCapacity: "Space remaining",
  remainingFiles: "Files remaining",
  expiresAt: "Expires on",
  uploadingFiles: "Uploading files",
  chooseOrDropFiles: "Choose files or drop them here",
  inboxUnavailable: "This inbox is full or has expired",
  keepPageOpen: "Keep this page open",
  multipleFilesHelp: "You can select multiple files",
  chooseUploadFiles: "Choose files to upload",
  currentUploads: "Current uploads",
  confirmingReceipt: "Confirming receipt…",
  cancelUpload: "Cancel upload",
  received: "Received",
  queuedUpload: "Queued",
  cancelledUpload: "Cancelled",
  uploading: "Uploading",
  backToPrevious: "Back",
};
