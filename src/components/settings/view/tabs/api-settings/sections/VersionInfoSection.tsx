import { ExternalLink, Star, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IS_PLATFORM } from '../../../../../../constants/config';
import { currentVersion } from '../../../../../../hooks/useVersionCheck';

const GITHUB_REPO_URL = 'https://github.com/siteboon/claudecodeui';
const DOCS_URL = 'https://cloudcli.ai/docs/plugin-overview';
const CLOUDCLI_URL = 'https://cloudcli.ai';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

export default function VersionInfoSection() {
  const { t } = useTranslation('settings');

  return (
    <div className="border-t border-border/50 pt-6">
      {/* About CloudCLI */}
      <div className="space-y-4">
        {/* Logo + name + version */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/90 shadow-sm">
            <MessageSquare className="h-4.5 w-4.5 text-primary-foreground" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">CloudCLI</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                v{currentVersion}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Open-source AI coding assistant interface
            </p>
          </div>
        </div>

        {/* Star on GitHub button */}
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <GitHubIcon className="h-4 w-4" />
          <Star className="h-3.5 w-3.5" />
          <span>Star on GitHub</span>
        </a>

        {/* Links */}
        <div className="flex flex-wrap gap-3 text-xs">
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <GitHubIcon className="h-3.5 w-3.5" />
            GitHub
          </a>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            Docs
          </a>
          <a
            href={CLOUDCLI_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            cloudcli.ai
          </a>
        </div>

        {/* Hosted CTA (OSS mode only) */}
        {!IS_PLATFORM && (
          <div className="rounded-xl border border-primary/10 bg-primary/5 p-4">
            <h4 className="text-sm font-medium text-foreground">Try CloudCLI Hosted</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Team collaboration, shared MCP configs, settings sync across environments, and managed infrastructure.
            </p>
            <a
              href={CLOUDCLI_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:underline"
            >
              Learn more
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
