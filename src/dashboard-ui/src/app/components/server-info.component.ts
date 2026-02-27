import { Component, input } from "@angular/core";
import type { ServerInfo } from "../../types";

@Component({
  selector: "app-server-info",
  standalone: true,
  templateUrl: "./server-info.component.html",
})
export class ServerInfoComponent {
  readonly info = input.required<ServerInfo>();
}
