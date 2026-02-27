import { useState, useRef, useEffect } from 'react';
import { Send, User, Sparkles } from 'lucide-react';
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
          <div key={i} className={`flex gap-4 ${m.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
              m.role === 'user' 
                ? 'bg-accent/10 text-accent' 
                : 'bg-background border border-panel-border text-text-muted'
            }`}>
              {m.role === 'user' ? <User size={18} /> : <Sparkles size={18} />}
            </div>
            <div className={`max-w-[80%] p-4 rounded-2xl text-[13px] leading-relaxed ${
              m.role === 'user' 
                ? 'bg-accent text-white rounded-tr-none shadow-lg shadow-accent/10' 
                : 'bg-background text-text-main border border-panel-border rounded-tl-none'
            }`}>
              {m.text}
            </div>
          </div>
        ))}

        {isThinking && (
          <div className="flex gap-4">
             <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-background border border-panel-border text-accent animate-pulse">
              <Sparkles size={18} />
            </div>
            <div className="bg-background border border-panel-border p-4 rounded-2xl rounded-tl-none flex gap-1.5 items-center">
              <span className="w-1.5 h-1.5 bg-accent/30 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 bg-accent/30 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 bg-accent/30 rounded-full animate-bounce" />
            </div>
          </div>
        )}
      </div>
      
      <div className="mt-4 pt-6 border-t border-panel-border relative">
        <input 
          type="text" 
          placeholder="Ask the Director anything..."
          className="w-full bg-background border border-panel-border rounded-xl py-3.5 px-5 pr-14 text-sm transition-all focus:outline-none focus:border-accent focus:ring-4 focus:ring-accent/5 placeholder:text-text-muted/50"
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
