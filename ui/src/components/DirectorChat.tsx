import React, { useState } from 'react';
import { Send, Sparkles } from 'lucide-react';

export function DirectorChat({ payload }: { payload: any }) {
  const [messages, setMessages] = useState([
    { role: 'ai', text: "Hello! I've analyzed the audio. We have some interesting pacing gaps between Speakers 1 and 2. What would you like to dive into?" }
  ]);
  const [input, setInput] = useState('');

  const handleSend = () => {
    if (!input) return;
    setMessages([...messages, { role: 'user', text: input }]);
    // In a real app, this would call the API
    setTimeout(() => {
      setMessages(prev => [...prev, { role: 'ai', text: "Analyzing that specific moment... It looks like the ducking intensity here is 0.99, which is keeping the focus very intimate." }]);
    }, 1000);
    setInput('');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto space-y-4 pr-2">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] p-3 rounded-lg text-sm ${m.role === 'user' ? 'bg-accent' : 'bg-white/5'}`}>
              {m.text}
            </div>
          </div>
        ))}
      </div>
      
      <div className="mt-4 relative">
        <input 
          type="text" 
          placeholder="Ask about a specific Mikup..."
          className="w-full bg-white/5 border border-white/10 rounded-full py-2 px-4 pr-10 text-sm focus:outline-none focus:border-accent"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
        />
        <button onClick={handleSend} className="absolute right-2 top-1.5 text-textMuted hover:text-white">
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
