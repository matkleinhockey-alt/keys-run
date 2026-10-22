CREATE TABLE "tag_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"weight_lb" numeric(7, 2) NOT NULL,
	"x" real NOT NULL,
	"z" real NOT NULL,
	"zone" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tagged_fish" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_no" serial NOT NULL,
	"species_key" text NOT NULL,
	"weight_lb" numeric(7, 2) NOT NULL,
	"x" real NOT NULL,
	"z" real NOT NULL,
	"status" text DEFAULT 'at_large' NOT NULL,
	"tagged_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tag_events" ADD CONSTRAINT "tag_events_tag_id_tagged_fish_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tagged_fish"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_events" ADD CONSTRAINT "tag_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tagged_fish" ADD CONSTRAINT "tagged_fish_tagged_by_users_id_fk" FOREIGN KEY ("tagged_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tag_events_tag_id_at_idx" ON "tag_events" USING btree ("tag_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "tagged_fish_tag_no_idx" ON "tagged_fish" USING btree ("tag_no");--> statement-breakpoint
CREATE INDEX "tagged_fish_species_at_large_idx" ON "tagged_fish" USING btree ("species_key") WHERE "tagged_fish"."status" = 'at_large';