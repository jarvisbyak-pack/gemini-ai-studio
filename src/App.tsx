import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { ChatView } from './components/ChatView';
import { VoiceCallView } from './components/VoiceCallView';
import { SettingsTab } from './components/SettingsTab';
import { PayloadInspectorTab } from './components/PayloadInspectorTab';
import { useVoiceConversation } from './hooks/useVoiceConversation';
import { AppSettings, ChatMessage, N8nNodeConfig } from './types';

const STORAGE_KEY_SETTINGS = 'n8n_ai_interface_settings_v1';
const STORAGE_KEY_MESSAGES = 'n8n_ai_interface_messages_v1';

const DEFAULT_SETTINGS: AppSettings = {
  activeNodeId: 'node-primary',
  nodes: [
    {
      id: 'node-primary',
      name: 'Primary n8n Webhook',
      url: '',
      method: 'POST',
      authType: 'none',
      authToken: '',
      customHeaderKey: '',
      customHeaderValue: '',
      lastTestedAt: null,
      lastStatus: null,
      lastLatencyMs: null,
    },
  ],
  continuousVoiceMode: true,
  voiceSettings: {
    voiceURI: '',
    rate: 1.0,
    pitch: 1.0,
    silenceThresholdMs: 1400,
    autoSpeakReplies: true,
    soundEffects: true,
  },
  sessionId: `n8n-session-${Math.random().toString(36).substring(2, 9)}`,
  customPayloadJson: '{"source": "ai_voice_interface"}',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'chat' | 'voice' | 'settings' | 'inspector'>('chat');
  const [isProcessing, setIsProcessing] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    status?: number;
    latencyMs?: number;
    data?: any;
    error?: string;
  } | null>(null);

  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(STORAGE_KEY_SETTINGS);
        if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      } catch (e) {
        console.warn('Failed to load settings:', e);
      }
    }
    return DEFAULT_SETTINGS;
  });

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(STORAGE_KEY_MESSAGES);
        if (saved) return JSON.parse(saved);
      } catch (e) {
        console.warn('Failed to load messages:', e);
      }
    }
    return [];
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
    } catch (e) {
      console.warn('Failed to save settings:', e);
    }
  }, [settings]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(messages));
    } catch (e) {
      console.warn('Failed to save messages:', e);
    }
  }, [messages]);

  const activeNode = settings.nodes.find((n) => n.id === settings.activeNodeId) || settings.nodes[0];

  const formatTime = () => {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleSendMessage = useCallback(
    async (text: string, mode: 'voice' | 'text' = 'text') => {
      if (!text.trim()) return;

      const userMessage: ChatMessage = {
        id: `msg-user-${Date.now()}`,
        sender: 'user',
        text: text.trim(),
        timestamp: formatTime(),
        mode,
      };

      setMessages((prev) => [...prev, userMessage]);
      setIsProcessing(true);

      try {
        let parsedCustomBody = {};
        if (settings.customPayloadJson) {
          try {
            parsedCustomBody = JSON.parse(settings.customPayloadJson);
          } catch {
            // ignore JSON parse error
          }
        }

        const requestHeaders: Record<string, string> = {};
        if (activeNode.authType === 'bearer' && activeNode.authToken) {
          requestHeaders['Authorization'] = `Bearer ${activeNode.authToken}`;
        } else if (
          activeNode.authType === 'custom_header' &&
          activeNode.customHeaderKey &&
          activeNode.customHeaderValue
        ) {
          requestHeaders[activeNode.customHeaderKey] = activeNode.customHeaderValue;
        }

        const res = await fetch('/api/n8n/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            webhookUrl: activeNode.url,
            method: activeNode.method || 'POST',
            headers: requestHeaders,
            customBody: parsedCustomBody,
            userMessage: text.trim(),
            inputMode: mode,
            sessionId: settings.sessionId,
            nodeEndpointId: activeNode.id,
          }),
        });

        const data = await res.json();

        const replyText =
          data?.reply?.text ||
          data?.reply?.rawOutput ||
          (data?.ok ? 'Workflow completed successfully.' : 'Unable to receive response from n8n.');

        const assistantMessage: ChatMessage = {
          id: `msg-ai-${Date.now()}`,
          sender: 'assistant',
          text: replyText,
          timestamp: formatTime(),
          mode,
          n8nStatus: data?.n8n?.status,
          n8nLatencyMs: data?.n8n?.latencyMs,
          n8nRawData: data?.n8n?.data,
          aiEnhanced: false,
          nodeName: activeNode.name,
          error: data?.n8n?.error,
        };

        setMessages((prev) => [...prev, assistantMessage]);

        if (settings.voiceSettings.autoSpeakReplies || mode === 'voice') {
          await voiceManager.speakText(replyText);
          voiceManager.onAiFinishedSpeaking();
        } else {
          voiceManager.setConversationState('idle');
        }
      } catch (err: any) {
        console.error('Dispatch error:', err);
        const errorMessage: ChatMessage = {
          id: `msg-err-${Date.now()}`,
          sender: 'assistant',
          text: `Error connecting to n8n node: ${err.message || 'Network request failed'}. Please check your Webhook URL in Settings.`,
          timestamp: formatTime(),
          mode,
          error: err.message,
        };
        setMessages((prev) => [...prev, errorMessage]);
        voiceManager.setConversationState('idle');
      } finally {
        setIsProcessing(false);
      }
    },
    [activeNode, settings]
  );

  const voiceManager = useVoiceConversation({
    voiceSettings: settings.voiceSettings,
    continuousMode: settings.continuousVoiceMode,
    onSendMessage: handleSendMessage,
    isAppProcessing: isProcessing,
  });

  const handleTestNode = async (node: N8nNodeConfig) => {
    if (!node.url) {
      alert('Please enter or paste a valid Webhook URL first.');
      return;
    }

    setTestLoading(true);
    setTestResult(null);

    try {
      const headers: Record<string, string> = {};
      if (node.authType === 'bearer' && node.authToken) {
        headers['Authorization'] = `Bearer ${node.authToken}`;
      } else if (node.authType === 'custom_header' && node.customHeaderKey && node.customHeaderValue) {
        headers[node.customHeaderKey] = node.customHeaderValue;
      }

      const res = await fetch('/api/n8n/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: node.url,
          method: node.method,
          headers,
        }),
      });

      const data = await res.json();
      setTestResult(data);

      const updatedNodes = settings.nodes.map((n) => {
        if (n.id === node.id) {
          return {
            ...n,
            lastTestedAt: new Date().toISOString(),
            lastStatus: data.status,
            lastLatencyMs: data.latencyMs,
          };
        }
        return n;
      });
      setSettings((prev) => ({ ...prev, nodes: updatedNodes }));
    } catch (err: any) {
      setTestResult({
        ok: false,
        error: err.message || 'Failed to ping n8n webhook',
      });
    } finally {
      setTestLoading(false);
    }
  };

  const handleToggleContinuousMode = () => {
    const nextState = !settings.continuousVoiceMode;
    setSettings((prev) => ({ ...prev, continuousVoiceMode: nextState }));
    if (!nextState) {
      voiceManager.stopListening();
    } else {
      voiceManager.startListening();
    }
  };

  const handleClearChat = () => {
    if (confirm('Are you sure you want to clear the conversation?')) {
      setMessages([]);
      localStorage.removeItem(STORAGE_KEY_MESSAGES);
    }
  };

  const lastAiMsg = [...messages].reverse().find((m) => m.sender === 'assistant');

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 flex flex-col font-sans selection:bg-orange-200">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        activeNode={activeNode}
        nodes={settings.nodes}
        onSelectNode={(nodeId) => setSettings((prev) => ({ ...prev, activeNodeId: nodeId }))}
        continuousMode={settings.continuousVoiceMode}
        onToggleContinuousMode={handleToggleContinuousMode}
        conversationState={voiceManager.conversationState}
        onStartListening={voiceManager.startListening}
        onStopListening={voiceManager.stopListening}
        onStopSpeaking={voiceManager.stopSpeaking}
      />

      <main className="flex-1 flex flex-col">
        {activeTab === 'chat' && (
          <ChatView
            messages={messages}
            onSendMessage={handleSendMessage}
            isProcessing={isProcessing}
            conversationState={voiceManager.conversationState}
            transcript={voiceManager.transcript}
            interimTranscript={voiceManager.interimTranscript}
            onStartListening={voiceManager.startListening}
            onStopListening={voiceManager.stopListening}
            onSpeakText={voiceManager.speakText}
            onStopSpeaking={voiceManager.stopSpeaking}
            continuousMode={settings.continuousVoiceMode}
            onToggleContinuousMode={handleToggleContinuousMode}
            activeNode={activeNode}
            onClearChat={handleClearChat}
          />
        )}

        {activeTab === 'voice' && (
          <VoiceCallView
            conversationState={voiceManager.conversationState}
            transcript={voiceManager.transcript}
            interimTranscript={voiceManager.interimTranscript}
            lastAiResponse={lastAiMsg?.text || ''}
            onStartListening={voiceManager.startListening}
            onStopListening={voiceManager.stopListening}
            onStopSpeaking={voiceManager.stopSpeaking}
            continuousMode={settings.continuousVoiceMode}
            onToggleContinuousMode={handleToggleContinuousMode}
            activeNode={activeNode}
            onCloseCall={() => setActiveTab('chat')}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsTab
            settings={settings}
            onUpdateSettings={setSettings}
            availableVoices={voiceManager.availableVoices}
            onTestNode={handleTestNode}
            testLoading={testLoading}
            testResult={testResult}
          />
        )}

        {activeTab === 'inspector' && (
          <PayloadInspectorTab
            messages={messages}
            onClearLogs={handleClearChat}
          />
        )}
      </main>
    </div>
  );
}
