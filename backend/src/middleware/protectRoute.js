import { clerkClient, requireAuth } from "@clerk/express";
import User from "../models/User.js";

export const protectRoute = [
  requireAuth(),
  async (req, res, next) => {
    try {
      const clerkId = req.auth().userId;

      if (!clerkId) return res.status(401).json({ message: "Unauthorized - invalid token" });

      // find user in DB by Clerk ID
      let user = await User.findOne({ clerkId });

      if (!user) {
        const clerkUser = await clerkClient.users.getUser(clerkId);
        const primaryEmail =
          clerkUser.emailAddresses?.find((email) => email.id === clerkUser.primaryEmailAddressId)
            ?.emailAddress ||
          clerkUser.emailAddresses?.[0]?.emailAddress;

        if (!primaryEmail) {
          return res.status(400).json({ message: "Authenticated user does not have a valid email" });
        }

        const fullName = `${clerkUser.firstName || ""} ${clerkUser.lastName || ""}`.trim();

        user = await User.findOneAndUpdate(
          { clerkId },
          {
            clerkId,
            email: primaryEmail,
            name: fullName || primaryEmail.split("@")[0],
            profileImage: clerkUser.imageUrl || "",
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }

      // attach user to req
      req.user = user;

      next();
    } catch (error) {
      console.error("Error in protectRoute middleware", error);
      res.status(500).json({ message: "Internal Server Error" });
    }
  },
];
