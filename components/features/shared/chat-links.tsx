"use client";

import { useTransition } from "react";
import { MessageCircle, Send } from "lucide-react";
import { logChatLinkOpened } from "@/lib/actions/leads";
import { Button } from "@/components/ui/button";

/**
 * WhatsApp / Telegram click-to-chat (doc 02 §C4, T2.6). Opening a link logs a
 * chat_link_opened event — the Phase 1 substitute for messaging APIs.
 */
export function ChatLinks({
  phoneE164,
  telegramUsername,
  hasWhatsapp,
  leadId = null,
  contactId = null,
  size = "sm",
}: {
  phoneE164: string | null;
  telegramUsername: string | null;
  hasWhatsapp?: boolean;
  leadId?: string | null;
  contactId?: string | null;
  size?: "sm" | "default";
}) {
  const [, startTransition] = useTransition();

  const open = (channel: "whatsapp" | "telegram", url: string) => {
    window.open(url, "_blank", "noopener");
    startTransition(async () => {
      try {
        await logChatLinkOpened(leadId, contactId, channel);
      } catch {
        // best-effort: the chat opened; a failed log must not crash the page
      }
    });
  };

  const waNumber = phoneE164?.replace(/^\+/, "");
  const showWa = Boolean(waNumber) && hasWhatsapp !== false;

  if (!showWa && !telegramUsername) return null;

  return (
    <div className="flex items-center gap-1">
      {showWa ? (
        <Button
          type="button"
          variant="outline"
          size={size}
          className="h-7 text-xs text-success"
          onClick={() => open("whatsapp", `https://wa.me/${waNumber}`)}
          title="Open WhatsApp chat (logged)"
        >
          <MessageCircle className="size-3.5" /> WhatsApp
        </Button>
      ) : null}
      {telegramUsername ? (
        <Button
          type="button"
          variant="outline"
          size={size}
          className="h-7 text-xs text-brand-500"
          onClick={() => open("telegram", `https://t.me/${telegramUsername}`)}
          title="Open Telegram chat (logged)"
        >
          <Send className="size-3.5" /> Telegram
        </Button>
      ) : null}
    </div>
  );
}
