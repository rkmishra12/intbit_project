import { Inngest } from "inngest";
import { connectDB } from "./db.js";
import User from "../models/User.js";
import { deleteStreamUser, upsertStreamUser } from "./stream.js";

export const inngest = new Inngest({ id: "intbit" });

const syncUser = inngest.createFunction(
  { id: "sync-user" },
  { event: "clerk/user.created" },
  async ({ event }) => {
    await connectDB();

    const { id, email_addresses, first_name, last_name, image_url } = event.data;
    const primaryEmail = email_addresses?.[0]?.email_address;

    if (!primaryEmail) {
      throw new Error("Clerk user payload is missing a primary email address");
    }

    const fullName = `${first_name || ""} ${last_name || ""}`.trim();
    const newUser = await User.findOneAndUpdate(
      { clerkId: id },
      {
        clerkId: id,
        email: primaryEmail,
        name: fullName || primaryEmail.split("@")[0],
        profileImage: image_url || "",
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await upsertStreamUser({
      id: newUser.clerkId.toString(),
      name: newUser.name,
      image: newUser.profileImage,
    });
  }
);

const deleteUserFromDB = inngest.createFunction(
  { id: "delete-user-from-db" },
  { event: "clerk/user.deleted" },
  async ({ event }) => {
    await connectDB();

    const { id } = event.data;
    await User.deleteOne({ clerkId: id });

    await deleteStreamUser(id.toString());
  }
);

export const functions = [syncUser, deleteUserFromDB];
