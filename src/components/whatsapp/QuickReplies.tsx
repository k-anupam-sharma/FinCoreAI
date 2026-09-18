import { Button } from "@/components/ui/button";

export function QuickReplies({ options, onSelect }: { options: string[]; onSelect: (value: string) => void }) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 py-1">
      {options.map((option) => (
        <Button key={option} type="button" variant="outline" size="sm" className="h-7 rounded-full border-whatsapp/40 bg-background text-xs text-whatsapp-dark hover:bg-whatsapp/10" onClick={() => onSelect(option)}>
          {option}
        </Button>
      ))}
    </div>
  );
}
