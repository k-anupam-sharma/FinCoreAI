import { useState, type FormEvent } from "react";
import { Send } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ChatInput({ onSend }: { onSend: (text: string) => void }) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    onSend(value);
    setValue("");
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 rounded-b-2xl border-t border-border bg-card px-3 py-3">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Type a message..."
        className="rounded-full"
        autoComplete="off"
      />
      <Button type="submit" size="icon" className="h-10 w-10 shrink-0 rounded-full bg-whatsapp text-whatsapp-foreground hover:bg-whatsapp/90">
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );
}
