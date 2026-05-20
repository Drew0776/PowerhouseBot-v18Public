import { Link } from "wouter";
import { AlertCircle, ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <AlertCircle className="h-10 w-10 text-muted-foreground mb-4" />
      <h1 className="text-lg font-semibold text-foreground mb-2">404 — Not Found</h1>
      <p className="text-sm text-muted-foreground mb-6">This page doesn't exist.</p>
      <Link href="/">
        <div className="flex items-center gap-2 text-sm text-primary hover:underline cursor-pointer">
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </div>
      </Link>
    </div>
  );
}
