import { board } from "@vercel/board";
import { http } from "@vercel/board/backend-http";
import { defineSchedule } from "eve/schedules";
import { FACTORY_CHANNEL } from "../../app/api/board/[[...path]]/connectors";
import { BOARD } from "../lib/identity";
import { CURRENT, latest, newer } from "../lib/template";

// Once a day (a Vercel Cron Job), a new template release becomes a task on the board, which the
// agent takes on with the update-template skill. Nothing runs a model on a day without one.
export default defineSchedule({
  cron: "0 9 * * *",
  async run({ waitUntil }) {
    waitUntil(
      (async () => {
        const version = await latest();
        if (!newer(version, CURRENT)) return;
        // As this deployment, on its own board. The ID makes each release one thread, however often it fires.
        await board({ backend: http(BOARD) }).post(FACTORY_CHANNEL, {
          id: `template-${version}`,
          text: `Template ${version} is out, and this factory is on ${CURRENT}. Update it.`,
          labels: { template: version },
          noSync: true,
        });
      })(),
    );
  },
});
