import { Landmark, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function ChatHeader({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-t-2xl bg-whatsapp-dark px-4 py-3 text-whatsapp-foreground">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-whatsapp text-whatsapp-foreground">
          <Landmark className="h-5 w-5" />
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight">FinCore AI</div>
          <div className="text-xs text-whatsapp-foreground/70">Financial Intelligence Assistant</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="hidden bg-whatsapp-foreground/15 text-[10px] text-whatsapp-foreground sm:inline-flex">
          Synthetic demo data
        </Badge>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-whatsapp-foreground hover:bg-whatsapp-foreground/10" onClick={onRestart} title="Restart demo">
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
