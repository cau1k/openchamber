import React from 'react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { RiExternalLinkLine, RiSignalTowerFill } from '@remixicon/react';

declare const __APP_VERSION__: string | undefined;

interface TailscaleStatus {
  enabled: boolean;
  hostname: string | null;
  ports: number[];
  urls: { port: number; url: string }[];
}

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AboutDialog: React.FC<AboutDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const [version, setVersion] = React.useState<string | null>(null);
  const [tailscale, setTailscale] = React.useState<TailscaleStatus | null>(null);

  React.useEffect(() => {
    if (!open) return;

    const isDesktop = typeof window !== 'undefined' && !!window.opencodeDesktop;

    if (isDesktop) {
      const fetchVersion = async () => {
        try {
          const { getVersion } = await import('@tauri-apps/api/app');
          const v = await getVersion();
          setVersion(v);
        } catch {
          setVersion(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null);
        }
      };
      fetchVersion();
    } else {
      setVersion(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null);
      
      // Fetch tailscale status (web only)
      fetch('/api/openchamber/tailscale')
        .then(res => res.ok ? res.json() : null)
        .then(data => setTailscale(data))
        .catch(() => setTailscale(null));
    }
  }, [open]);

  const displayVersion = version;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs p-6">
        <div className="flex flex-col items-center text-center space-y-4">
          <OpenChamberLogo width={64} height={64} />

          <div className="space-y-1">
            <h2 className="text-lg font-semibold">OpenChamber</h2>
            {displayVersion && (
              <p className="typography-meta text-muted-foreground">
                Version {displayVersion}
              </p>
            )}
          </div>

          {tailscale?.enabled && tailscale.urls.length > 0 && (
            <div className="w-full pt-2 border-t border-border">
              <div className="flex items-center justify-center gap-1.5 mb-3">
                <RiSignalTowerFill className="h-4 w-4 text-emerald-500" />
                <span className="typography-meta font-medium">Tailscale Serves</span>
              </div>
              <div className="space-y-2">
                {tailscale.urls.map(({ port, url }) => (
                  <a
                    key={port}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/50 hover:bg-muted transition-colors group"
                  >
                    <span className="typography-meta text-muted-foreground truncate">
                      {url.replace('https://', '')}
                    </span>
                    <RiExternalLinkLine className="h-3.5 w-3.5 text-muted-foreground/60 group-hover:text-foreground transition-colors flex-shrink-0 ml-2" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
