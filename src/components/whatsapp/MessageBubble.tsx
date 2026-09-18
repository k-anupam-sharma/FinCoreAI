import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/hooks/useFinCoreChat";

function renderFormattedLine(line: string, key: number) {
  const parts = line.split(/\*([^*]+)\*/g);
  return (
    <span key={key}>
      {parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>))}
    </span>
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.sender === "user";
  const lines = message.text.split("\n");

  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-sm",
          isUser ? "bg-chat-bubbleOut text-chat-bubbleOutForeground" : "bg-chat-bubbleIn text-chat-bubbleInForeground"
        )}
      >
        {lines.map((line, i) => (
          <div key={i}>{renderFormattedLine(line, i) || "\u00A0"}</div>
        ))}
        <div className={cn("mt-1 text-right text-[10px]", isUser ? "text-chat-bubbleOutForeground/60" : "text-chat-bubbleInForeground/50")}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
    </div>
  );
}
