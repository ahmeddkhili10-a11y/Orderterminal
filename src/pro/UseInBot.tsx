// "Use in a bot": the button on a Quant desk panel that sends the model on
// screen — with the settings it is being studied with — into the Strategy
// Lab's bot builder (lab/bridge.ts), as a strategy, a filter, a second
// opinion, a decision maker or a sizing rule.
import { useState } from 'react';
import { sendToBot, type LabSend } from '../lab/bridge';
import { Popover } from '../ui/controls';

export interface UseOption {
  /** what it becomes in the bot, in a few words */
  label: string;
  /** what that does, in a line */
  plain: string;
  send: Omit<LabSend, 'from'>;
}

export function UseInBot({ from, options, title }: { from: string; options: UseOption[]; title?: string }) {
  const [sent, setSent] = useState('');
  if (!options.length) return null;
  return (
    <Popover label="⇢ Use in a bot" title={title ?? 'Put this model into a strategy in the bot builder (Strategy Lab), with the settings shown here'} align="right">
      <div className="use-bot" data-from={from}>
        <div className="use-bot-head">Put it into a bot — the Strategy Lab then tests the bot on data it never saw</div>
        {options.map((o) => (
          <button
            key={o.label}
            className={`use-bot-opt${sent === o.label ? ' sent' : ''}`}
            data-use={`${o.send.block}:${o.send.id}`}
            onClick={() => {
              sendToBot({ ...o.send, from });
              setSent(o.label);
            }}
          >
            <b>
              {sent === o.label ? '✓ ' : ''}
              {o.label}
            </b>
            <span>{o.plain}</span>
          </button>
        ))}
        {sent && <div className="use-bot-foot">Sent — the bot builder (BOT) has it. Send another, or open the Strategy Lab to test.</div>}
      </div>
    </Popover>
  );
}
