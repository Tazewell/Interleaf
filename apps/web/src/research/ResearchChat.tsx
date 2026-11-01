import { useEffect, useState } from "react";
import type { ResearchRunInput } from "@interleaf/core";
import { Button } from "@interleaf/ui/components/button";
import { Textarea } from "@interleaf/ui/components/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@interleaf/ui/components/select";
import { MessageMarkdown } from "../chat/MessageMarkdown";
import type { ResearchState } from "./research-session";
const labels = {
  overview: "主题综述",
  compare: "比较论文",
  ideas: "探索想法",
  question: "研究追问",
};
export function ResearchChat({
  state,
  disabled,
  onSend,
}: {
  state: ResearchState;
  disabled: boolean;
  onSend: (
    question: string,
    mode: ResearchRunInput["mode"],
    online?: boolean,
  ) => void;
}) {
  const [question, setQuestion] = useState("");
  useEffect(() => {
    if (state.rejectedDraft) setQuestion(state.rejectedDraft.question);
  }, [state.rejectedDraft]);
  const [mode, setMode] = useState<keyof typeof labels>("overview");
  const send = (online = false) => {
    if (!question.trim() || disabled) return;
    onSend(question.trim(), online ? "question" : mode, online);
    setQuestion("");
  };
  return (
    <section aria-label="研究会话" className="space-y-3">
      {state.messages.map((message) => (
        <article key={message.id} className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {message.role === "user" ? "你" : "研究回答"}
          </p>
          <MessageMarkdown content={message.content} animated={false} />
        </article>
      ))}
      {state.activity && (
        <p role="status" className="text-sm text-muted-foreground">
          {state.activity}
        </p>
      )}
      {state.draft &&
        !state.messages.some(
          (m) => m.role === "assistant" && m.runId === state.run?.id,
        ) &&
        state.run?.status !== "completed" && (
          <div>
            <p className="text-xs text-muted-foreground">未保存的阶段输出</p>
            <MessageMarkdown content={state.draft} animated={false} />
          </div>
        )}
      <Select
        value={mode}
        onValueChange={(value) => {
          if (value && value in labels) setMode(value as keyof typeof labels);
        }}
      >
        <SelectTrigger aria-label="研究方式" className="w-40">
          <SelectValue>{labels[mode]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {Object.entries(labels).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Textarea
        aria-label="研究问题"
        placeholder="输入研究问题或需要查找的论文链接"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={disabled || !question.trim()}
          onClick={() => send()}
        >
          {mode === "question" ? "发送追问" : "开始研究"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !question.trim()}
          onClick={() => send(true)}
        >
          联网找论文
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        研究在后台继续；离开页面仅断开显示。追问使用本会话已有研究上下文。
      </p>
    </section>
  );
}
