import { useState, useEffect } from "react";
import { Search, RefreshCw, Mail, Moon, Sun, ChevronLeft, Plus, Settings, ExternalLink } from "lucide-react";
import {
  useGetInbox,
  getGetInboxQueryKey,
  useGetEmail,
  getGetEmailQueryKey,
  useListDomains,
} from "@workspace/api-client-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link } from "wouter";

function randomPrefix(len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(
    { length: len },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

function isCaptchaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: { error?: string } }).data;
  return data?.error === "CAPTCHA_REQUIRED";
}

function getYopmailUrl(email: string): string {
  const atIdx = email.indexOf("@");
  if (atIdx === -1) return "https://yopmail.com";
  const login = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  const isYopmail = domain.includes("yopmail");
  return isYopmail
    ? `https://yopmail.com/en/wm?login=${login}`
    : `https://yopmail.com/en/wm?login=${login}&domain=${domain}`;
}

function formatDate(dateStr: string) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

export default function InboxPage() {
  const [darkMode, setDarkMode] = useState(() => {
    return localStorage.getItem("ydm_dark") === "1";
  });

  const [quickInput, setQuickInput] = useState("");
  const [selectedDomain, setSelectedDomain] = useState("");
  const [activeEmail, setActiveEmail] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("email") || "";
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const { data: domainsData } = useListDomains();
  const domains = domainsData?.domains || [];

  useEffect(() => {
    if (domains.length > 0 && !selectedDomain) {
      setSelectedDomain(domains[0].domain);
    }
  }, [domains, selectedDomain]);

  useEffect(() => {
    localStorage.setItem("ydm_dark", darkMode ? "1" : "0");
  }, [darkMode]);

  useEffect(() => {
    if (activeEmail) {
      const url = new URL(window.location.href);
      url.searchParams.set("email", activeEmail);
      window.history.replaceState({}, "", url.toString());
    }
  }, [activeEmail]);

  const {
    data: inboxData,
    isLoading: isLoadingInbox,
    isFetching,
    refetch,
  } = useGetInbox(
    { email: activeEmail },
    {
      query: {
        enabled: !!activeEmail,
        refetchInterval: autoRefresh ? 10000 : false,
        queryKey: getGetInboxQueryKey({ email: activeEmail }),
      },
    },
  );

  const { data: emailData, isLoading: isLoadingEmail, isError: isEmailError, error: emailError } = useGetEmail(
    { email: activeEmail, id: selectedId || "" },
    {
      query: {
        enabled: !!selectedId && !!activeEmail,
        queryKey: getGetEmailQueryKey({
          email: activeEmail,
          id: selectedId || "",
        }),
      },
    },
  );

  const handleQuickSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickInput.trim()) return;
    setActiveEmail(quickInput.trim().toLowerCase());
    setSelectedId(null);
  };

  const handleCreateRandom = () => {
    if (!selectedDomain) return;
    const email = `${randomPrefix()}@${selectedDomain}`;
    setActiveEmail(email);
    setSelectedId(null);
  };

  const handleRefresh = () => {
    if (activeEmail) refetch();
  };

  const unreadCount = inboxData?.messages.filter((m) => !m.isRead).length ?? 0;

  return (
    <div className={darkMode ? "dark" : ""}>
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 transition-colors duration-200">
        {/* Header */}
        <header className="bg-white dark:bg-gray-800 shadow-sm py-5 px-4 text-center relative">
          <Link
            href="/admin"
            className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title="Admin Panel"
          >
            <Settings className="w-5 h-5" />
          </Link>
          <div className="flex items-center justify-center gap-2 mb-1">
            <Mail className="w-7 h-7 text-green-500" />
            <h1 className="text-2xl font-bold text-green-500">
              Yuen Dispo Mail
            </h1>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Professional Disposable Email Generator
          </p>
        </header>

        <div className="max-w-lg mx-auto px-4 py-5 space-y-4">
          {/* Quick Access */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm p-4">
            <p className="text-xs font-bold text-green-500 uppercase tracking-wider mb-3">
              Quick Access
            </p>
            <form onSubmit={handleQuickSearch} className="flex gap-2">
              <input
                type="text"
                placeholder="Access any email address..."
                value={quickInput}
                onChange={(e) => setQuickInput(e.target.value)}
                className="flex-1 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-white outline-none focus:ring-2 focus:ring-green-400 transition-all"
              />
              <button
                type="submit"
                className="bg-green-500 hover:bg-green-600 active:bg-green-700 text-white px-3.5 py-2 rounded-lg transition-colors"
              >
                <Search className="w-4 h-4" />
              </button>
            </form>
          </div>

          {/* Generate Address */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm p-4">
            <p className="text-xs font-bold text-green-500 uppercase tracking-wider mb-3">
              Generate Address
            </p>
            <Select value={selectedDomain} onValueChange={setSelectedDomain}>
              <SelectTrigger className="w-full mb-3 border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white">
                <SelectValue placeholder="Select a domain..." />
              </SelectTrigger>
              <SelectContent>
                {domains.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-400">
                    No domains configured
                  </div>
                ) : (
                  domains.map((d) => (
                    <SelectItem key={d.id} value={d.domain}>
                      {d.label ? `${d.label} (${d.domain})` : d.domain}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <button
              onClick={handleCreateRandom}
              disabled={!selectedDomain}
              className="w-full bg-green-500 hover:bg-green-600 active:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm mb-2.5 flex items-center justify-center gap-2 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create Random Email
            </button>
            <button
              onClick={handleRefresh}
              disabled={!activeEmail || isFetching}
              className="w-full border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 active:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed font-semibold py-2.5 rounded-lg text-sm flex items-center justify-center gap-2 transition-colors"
            >
              <RefreshCw
                className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`}
              />
              Refresh Inbox
            </button>
          </div>

          {/* Inbox / Email Reader */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm p-4">
            {selectedId ? (
              <div>
                <button
                  onClick={() => setSelectedId(null)}
                  className="flex items-center gap-1 text-green-500 hover:text-green-600 text-sm font-medium mb-4 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back to Inbox
                </button>

                {isLoadingEmail ? (
                  <div className="space-y-3 animate-pulse">
                    <div className="h-5 bg-gray-100 dark:bg-gray-700 rounded w-3/4" />
                    <div className="h-4 bg-gray-100 dark:bg-gray-700 rounded w-1/2" />
                    <div className="h-3 bg-gray-100 dark:bg-gray-700 rounded w-1/3" />
                    <div className="h-64 bg-gray-50 dark:bg-gray-700/50 rounded-lg mt-4" />
                  </div>
                ) : isEmailError && isCaptchaError(emailError) ? (
                  <div className="text-center py-6 px-2">
                    <div className="w-12 h-12 bg-yellow-50 dark:bg-yellow-900/20 rounded-full flex items-center justify-center mx-auto mb-3">
                      <ExternalLink className="w-6 h-6 text-yellow-500" />
                    </div>
                    <p className="font-semibold text-gray-800 dark:text-white text-sm mb-1">
                      CAPTCHA required by YopMail
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 leading-relaxed">
                      YopMail is asking for a CAPTCHA to view this email.
                      Open it directly on their site to complete the check.
                    </p>
                    <a
                      href={getYopmailUrl(activeEmail)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 bg-green-500 hover:bg-green-600 active:bg-green-700 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Open on YopMail
                    </a>
                  </div>
                ) : emailData ? (
                  <div>
                    <h2 className="font-bold text-gray-900 dark:text-white text-base mb-2 leading-snug">
                      {emailData.subject || "(No Subject)"}
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-0.5">
                      <span className="font-medium">From:</span>{" "}
                      {emailData.from || "Unknown"}
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">
                      {emailData.date}
                    </p>
                    <div className="border border-gray-100 dark:border-gray-700 rounded-xl overflow-hidden">
                      <iframe
                        title="Email Content"
                        srcDoc={emailData.html || "<p>No content</p>"}
                        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
                        className="w-full min-h-[300px] h-[50vh] border-0 bg-white"
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Failed to load message.
                  </p>
                )}
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-gray-900 dark:text-white">
                    Inbox
                    {unreadCount > 0 && (
                      <span className="ml-2 inline-flex items-center justify-center bg-green-500 text-white text-xs font-bold rounded-full w-5 h-5">
                        {unreadCount}
                      </span>
                    )}
                  </span>
                  {activeEmail && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[180px]">
                      {activeEmail}
                    </span>
                  )}
                </div>

                <label className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mb-4 mt-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(e) => setAutoRefresh(e.target.checked)}
                    className="accent-green-500 w-4 h-4"
                  />
                  Auto Refresh (10s)
                </label>

                {!activeEmail ? (
                  <p className="text-sm text-gray-400 dark:text-gray-500">
                    No emails yet. Generate an email to start receiving messages.
                  </p>
                ) : isLoadingInbox ? (
                  <div className="space-y-3">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="h-[68px] bg-gray-100 dark:bg-gray-700 animate-pulse rounded-xl"
                      />
                    ))}
                  </div>
                ) : !inboxData || inboxData.messages.length === 0 ? (
                  <p className="text-sm text-gray-400 dark:text-gray-500">
                    No emails yet. Generate an email to start receiving messages.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {inboxData.messages.map((msg) => (
                      <button
                        key={msg.id}
                        onClick={() => setSelectedId(msg.id)}
                        className="w-full text-left p-3 border border-gray-100 dark:border-gray-700 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-700/60 active:bg-gray-100 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-0.5">
                          <span
                            className={`text-sm truncate max-w-[200px] ${
                              !msg.isRead
                                ? "font-bold text-gray-900 dark:text-white"
                                : "font-medium text-gray-600 dark:text-gray-400"
                            }`}
                          >
                            {msg.from || "Unknown Sender"}
                          </span>
                          <span className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 ml-2">
                            {formatDate(msg.date)}
                          </span>
                        </div>
                        <p
                          className={`text-xs truncate ${
                            !msg.isRead
                              ? "text-gray-700 dark:text-gray-300"
                              : "text-gray-400 dark:text-gray-500"
                          }`}
                        >
                          {msg.subject || "(No Subject)"}
                        </p>
                        {!msg.isRead && (
                          <span className="inline-block mt-1 w-2 h-2 rounded-full bg-green-500" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <footer className="text-center text-xs text-gray-400 dark:text-gray-600 py-6">
          © 2025 Yuen Dispo Mail - All rights reserved
        </footer>

        <button
          onClick={() => setDarkMode((d) => !d)}
          className="fixed bottom-6 right-6 w-10 h-10 bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-800 rounded-full shadow-lg flex items-center justify-center hover:scale-110 transition-transform"
          aria-label="Toggle dark mode"
        >
          {darkMode ? (
            <Sun className="w-5 h-5" />
          ) : (
            <Moon className="w-5 h-5" />
          )}
        </button>
      </div>
    </div>
  );
}
