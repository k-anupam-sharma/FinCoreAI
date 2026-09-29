import { useEffect, useRef } from "react";
import { useFinCoreChat } from "@/hooks/useFinCoreChat";
import { ChatHeader } from "./ChatHeader";
import { ChatInput } from "./ChatInput";
import { MessageBubble } from "./MessageBubble";
import { QuickReplies } from "./QuickReplies";

export function ChatShell() {
  const { messages, sendMessage, restartDemo } = useFinCoreChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const lastMessage = messages[messages.length - 1];
  const lastQuickReplies = lastMessage?.sender === "bot" ? lastMessage.quickReplies ?? [] : [];

  return (
    <div className="flex h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-chat-bg shadow-xl">
      <ChatHeader onRestart={restartDemo} />

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-4">
        {messages.length === 0 && (
          <div className="rounded-lg bg-chat-bubbleIn px-3 py-3 text-sm text-chat-bubbleInForeground shadow-sm">
            Send <strong>Hi</strong> to begin onboarding onto FinCore AI, or type <strong>Login</strong> if you already have an account.
          </div>
        )}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {lastQuickReplies.length > 0 && <QuickReplies options={lastQuickReplies} onSelect={sendMessage} />}
      </div>

      <ChatInput onSend={sendMessage} />
    </div>
  );
}
