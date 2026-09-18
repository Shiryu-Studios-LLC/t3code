import { createFileRoute } from "@tanstack/react-router";

import { SeriesBoardPage } from "../components/shiryugen/SeriesBoardPage";

export const Route = createFileRoute("/series")({
  component: SeriesBoardPage,
});
