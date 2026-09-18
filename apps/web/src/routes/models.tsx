import { createFileRoute } from "@tanstack/react-router";

import { ModelsPage } from "../components/shiryugen/ModelsPage";

export const Route = createFileRoute("/models")({
  component: ModelsPage,
});
