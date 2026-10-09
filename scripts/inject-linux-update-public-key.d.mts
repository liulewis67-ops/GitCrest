interface AfterPackContext {
  electronPlatformName: string;
  appOutDir: string;
}

export default function injectLinuxUpdatePublicKey(context: AfterPackContext): Promise<void>;
