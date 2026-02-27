import { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import type { DirectorChatMessage, MikupPayload } from '../types';

function getInitialMessages(payload: MikupPayload | null): DirectorChatMessage[] {
  if (payload?.ai_report) {
    return [
      { role: 'ai', text: 'Pipeline analysis complete. I have synthesized the production data into an actionable report.' },
      { role: 'ai', text: payload.ai_report },
    ];
  }
  if (payload) {
    return [{ role: 'ai', text: 'Audio architecture deconstructed. Metrics are available for review in the dashboard.' }];
  }
  return [{ role: 'ai', text: 'System Online. Awaiting audio master for architectural deconstruction.' }];
}

export function DirectorChat({ payload }: { payload: MikupPayload | null }) {
  const [messages, setMessages] = useState<DirectorChatMessage[]>(() => getInitialMessages(payload));
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isThinking]);

  const handleSend = () => {
    if (!input.trim()) return;
    
    setMessages(prev => [...prev, { role: 'user', text: input }]);
    setInput('');
    setIsThinking(true);
    
    setTimeout(() => {
      setIsThinking(false);
      setMessages(prev => [...prev, { role: 'ai', text: "Analyzing the session dynamics... I've detected a significant shift in spatial breathing around the second act. Would you like a detailed breakdown of the reverb indexing for those specific segments?" }]);
    }, 1200);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-6 pr-4 pb-4 scroll-smooth no-scrollbar">
        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col gap-0.5 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">
              {m.role === 'user' ? 'You' : 'Director'}
            </span>
            <div className={`max-w-[85%] px-3 py-2 text-[13px] leading-relaxed border ${
              m.role === 'user'
                ? 'bg-accent/5 border-accent/20 text-text-main'
                : 'bg-transparent border-panel-border text-text-main'
            }`}>
              {m.text}
            </div>
          </div>
        ))}

        {isThinking && (
          <div className="flex flex-col items-start gap-0.5">
            <span className="text-[9px] uppercase tracking-widest font-bold text-text-muted">Director</span>
            <div className="border border-panel-border px-3 py-2 flex gap-1.5 items-center">
              <span className="w-1.5 h-1.5 bg-accent/40 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 bg-accent/40 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 bg-accent/40 rounded-full animate-bounce" />
            </div>
          </div>
        )}
      </div>
      
      <div className="mt-4 pt-6 border-t border-panel-border relative">
        <input 
          type="text" 
          placeholder="Ask the Director anything..."
          className="w-full bg-transparent border border-panel-border py-2.5 px-4 pr-12 text-sm transition-colors focus:outline-none focus:border-accent placeholder:text-text-muted/40"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
        />
        <button 
          onClick={handleSend} 
          disabled={!input.trim() || isThinking}
          className="absolute right-3.5 top-[38px] w-9 h-9 flex items-center justify-center rounded-lg text-text-muted hover:text-accent hover:bg-accent/5 transition-all disabled:opacity-20"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
