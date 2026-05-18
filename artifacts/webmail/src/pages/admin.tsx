import { useState } from "react";
import { useLocation } from "wouter";
import { Mail, Plus, Trash2, Shield, Search, Lock, Eye, EyeOff, ArrowLeft } from "lucide-react";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDomains,
  getListDomainsQueryKey,
  useAddDomain,
  useDeleteDomain,
} from "@workspace/api-client-react";
import { Link } from "wouter";

const ADMIN_PASSWORD = "yuennix";
const SESSION_KEY = "ydm_admin_auth";

function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pw === ADMIN_PASSWORD) {
      sessionStorage.setItem(SESSION_KEY, "1");
      onUnlock();
    } else {
      setError(true);
      setPw("");
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-sm p-8 w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 rounded-full bg-green-50 flex items-center justify-center mb-3">
            <Lock className="w-7 h-7 text-green-500" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">Admin Panel</h1>
          <p className="text-sm text-gray-500 mt-1">Enter your password to continue</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <input
              type={show ? "text" : "password"}
              placeholder="Password"
              value={pw}
              autoFocus
              onChange={(e) => { setPw(e.target.value); setError(false); }}
              className={`w-full border ${error ? "border-red-400 bg-red-50" : "border-gray-200"} rounded-xl px-4 py-3 pr-10 text-sm outline-none focus:ring-2 focus:ring-green-400 transition-all`}
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {error && (
            <p className="text-xs text-red-500 text-center">Incorrect password. Try again.</p>
          )}
          <button
            type="submit"
            className="w-full bg-green-500 hover:bg-green-600 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
          >
            Unlock
          </button>
        </form>
        <div className="mt-4 text-center">
          <Link href="/" className="text-sm text-gray-400 hover:text-gray-600 flex items-center justify-center gap-1 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Webmail
          </Link>
        </div>
      </div>
    </div>
  );
}

function AdminContent() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: domainsData, isLoading: isLoadingDomains } = useListDomains();
  const domains = domainsData?.domains || [];

  const [newDomain, setNewDomain] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [quickEmail, setQuickEmail] = useState("");

  const addDomainMutation = useAddDomain({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDomainsQueryKey() });
        setNewDomain("");
        setNewLabel("");
      },
    },
  });

  const deleteDomainMutation = useDeleteDomain({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDomainsQueryKey() });
      },
    },
  });

  const handleAddDomain = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain) return;
    addDomainMutation.mutate({ data: { domain: newDomain.trim().toLowerCase(), label: newLabel || null } });
  };

  const handleQuickAccess = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickEmail.trim()) return;
    setLocation(`/?email=${encodeURIComponent(quickEmail.trim().toLowerCase())}`);
  };

  const handleLogout = () => {
    sessionStorage.removeItem(SESSION_KEY);
    setLocation("/");
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm py-5 px-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-green-500" />
          <span className="font-bold text-gray-900">Admin Panel</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition-colors">
            <Mail className="w-4 h-4" />
            Webmail
          </Link>
          <button
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-red-500 transition-colors"
          >
            Logout
          </button>
        </div>
      </header>

      <div className="max-w-lg mx-auto px-4 py-5 space-y-4">
        {/* Quick Inbox Access */}
        <div className="bg-white rounded-2xl shadow-sm p-4">
          <p className="text-xs font-bold text-green-500 uppercase tracking-wider mb-3">
            Quick Inbox Access
          </p>
          <form onSubmit={handleQuickAccess} className="flex gap-2">
            <input
              type="text"
              placeholder="user@yourdomain.com"
              value={quickEmail}
              onChange={(e) => setQuickEmail(e.target.value)}
              className="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-400 transition-all"
            />
            <button
              type="submit"
              disabled={!quickEmail.trim()}
              className="bg-green-500 hover:bg-green-600 disabled:opacity-40 text-white px-3.5 py-2.5 rounded-xl transition-colors"
            >
              <Search className="w-4 h-4" />
            </button>
          </form>
        </div>

        {/* Add Domain */}
        <div className="bg-white rounded-2xl shadow-sm p-4">
          <p className="text-xs font-bold text-green-500 uppercase tracking-wider mb-3">
            Add Domain
          </p>
          <p className="text-xs text-gray-400 mb-4 leading-relaxed">
            Add any domain that has its MX records pointing to Yopmail (mx1.yopmail.com / mx2.yopmail.com).
          </p>
          <form onSubmit={handleAddDomain} className="space-y-3">
            <input
              type="text"
              placeholder="mail.yourdomain.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              disabled={addDomainMutation.isPending}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-400 transition-all disabled:opacity-60"
            />
            <input
              type="text"
              placeholder="Label (optional, e.g. Work)"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              disabled={addDomainMutation.isPending}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-green-400 transition-all disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!newDomain || addDomainMutation.isPending}
              className="w-full bg-green-500 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 transition-colors"
            >
              <Plus className="w-4 h-4" />
              {addDomainMutation.isPending ? "Adding..." : "Add Domain"}
            </button>
            {addDomainMutation.isError && (
              <p className="text-xs text-red-500 text-center">
                Failed to add domain. It may already exist.
              </p>
            )}
          </form>
        </div>

        {/* Managed Domains */}
        <div className="bg-white rounded-2xl shadow-sm p-4">
          <p className="text-xs font-bold text-green-500 uppercase tracking-wider mb-3">
            Managed Domains
          </p>
          {isLoadingDomains ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <div key={i} className="h-16 bg-gray-100 animate-pulse rounded-xl" />
              ))}
            </div>
          ) : domains.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <Shield className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No domains configured yet.</p>
              <p className="text-xs mt-1">Add your first domain above.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {domains.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between p-3 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-gray-900 truncate">
                        {d.domain}
                      </span>
                      {d.label && (
                        <span className="text-xs bg-green-50 text-green-600 border border-green-100 rounded-full px-2 py-0.5">
                          {d.label}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-gray-400">
                      Added {format(new Date(d.createdAt), "MMM d, yyyy")}
                    </span>
                  </div>
                  <button
                    onClick={() => deleteDomainMutation.mutate({ id: d.id })}
                    disabled={deleteDomainMutation.isPending}
                    className="text-gray-300 hover:text-red-500 disabled:opacity-40 transition-colors ml-3 flex-shrink-0"
                    aria-label="Delete domain"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* MX Setup Guide */}
        <div className="bg-white rounded-2xl shadow-sm p-4">
          <p className="text-xs font-bold text-green-500 uppercase tracking-wider mb-3">
            DNS Setup Guide
          </p>
          <p className="text-xs text-gray-500 mb-3 leading-relaxed">
            To connect your domain, add these MX records in your DNS provider:
          </p>
          <div className="space-y-2">
            {[
              { name: "MX", value: "mx1.yopmail.com", priority: "10" },
              { name: "MX", value: "mx2.yopmail.com", priority: "20" },
            ].map((r) => (
              <div key={r.value} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono font-bold text-green-600 w-6">{r.name}</span>
                  <span className="text-xs font-mono text-gray-700">{r.value}</span>
                </div>
                <span className="text-xs text-gray-400">Priority {r.priority}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-3">
            DNS changes can take up to 48 hours to propagate.
          </p>
        </div>
      </div>

      <footer className="text-center text-xs text-gray-400 py-6">
        © 2025 Yuen Dispo Mail - All rights reserved
      </footer>
    </div>
  );
}

export default function AdminPage() {
  const [unlocked, setUnlocked] = useState(() => {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  });

  if (!unlocked) {
    return <PasswordGate onUnlock={() => setUnlocked(true)} />;
  }

  return <AdminContent />;
}
