import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { ChatMessage } from "@shared/agent-pane/types";
import { CodeBlock } from "./CodeBlock";

const REMARK_PLUGINS = [remarkGfm];

// Markdown overrides:
// - Fenced code blocks (className matches "language-XXX") render via
//   Shiki-backed CodeBlock; inline code stays as plain <code>.
// - The default <pre> wrapper is suppressed so CodeBlock owns its layout.
const MD_COMPONENTS: Components = {
  code({ className, children, ...rest }) {
    const match = /language-([\w+-]+)/.exec(className ?? "");
    if (match) {
      return (
        <CodeBlock
          lang={match[1] ?? "text"}
          code={String(children).replace(/\n$/, "")}
        />
      );
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    // Block code is fully rendered by CodeBlock; drop the wrapping <pre>.
    return <>{children}</>;
  },
};

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const cls = `msg msg--${message.role}${message.streaming ? " msg--streaming" : ""}`;
  return (
    <div className={cls}>
      <div className="msg__role">{isUser ? "you" : "claude"}</div>
      <div className="msg__body">
        {isUser ? (
          <span className="msg__text">{message.text}</span>
        ) : (
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
            {message.text}
          </ReactMarkdown>
        )}
        {message.streaming && (
          <span className="msg__cursor" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
