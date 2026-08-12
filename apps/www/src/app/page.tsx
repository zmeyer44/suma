import { Features } from "@/components/sections/features";
import { Hero } from "@/components/sections/hero";
import { Values } from "@/components/sections/values";
import { Waitlist } from "@/components/sections/waitlist";
import { Workspace } from "@/components/sections/workspace";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Features />
      <Workspace />
      <Values />
      <Waitlist />
    </>
  );
}
