import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import type { InitData } from "./types";

declare global {
  interface Window { __INIT__: InitData; }
}

bootstrapApplication(AppComponent);
