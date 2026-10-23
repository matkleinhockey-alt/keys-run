CREATE TABLE "estates" (
	"parcel_id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"price" integer NOT NULL,
	"founding" boolean DEFAULT false NOT NULL,
	"build" jsonb NOT NULL,
	"bought_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "estates" ADD CONSTRAINT "estates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "estates_owner_id_idx" ON "estates" USING btree ("owner_id");