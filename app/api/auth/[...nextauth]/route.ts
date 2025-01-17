import { dbConnect } from '@/lib/dbConnect';
import { Users } from '@/models/user.model';
import { OAuth2Client, LoginTicket } from 'google-auth-library';
import NextAuth, { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { JWT } from 'next-auth/jwt';
import { NextResponse } from 'next/server';

import { UserToken } from "@/models/usertoken";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";

interface User {
  _id: Types.ObjectId;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export async function generateTokens(user: User): Promise<Tokens> {
  try {
    const payload = {
      _id: user._id,
    };

    const accessToken = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET || "", {
      expiresIn: "5d",
    });

    const refreshToken = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET || "", {
      expiresIn: "30d",
    });

    const userToken = await UserToken.findOne({ userId: user._id });
    if (userToken) {
      await userToken.deleteOne();
    }

    await new UserToken({ userId: user._id, token: refreshToken }).save();

    return { accessToken, refreshToken };
  } catch (err) {
    throw err;
  }
}


// OAuth2Client instance
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID as string);

// Extend the NextAuth types
declare module 'next-auth' {
  interface User {
    email: string;
    name: string;
  }

  interface Session {
    accessToken?: string;
    accessTokenBackend?: string;
    idToken?: string;
    error?: string;
  }

  interface Token {
    accessTokenExpires: number;
    accessToken: string;
    refreshToken: string;
    idToken: string | undefined;
    accessTokenFromBackend?: string;
    error?: string;
  }
}

// Define type for account in JWT callback
interface Account {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

// Define the gettokenfrombackend function
const gettokenfrombackend = async (user: any, account: Account): Promise<string> => {
  await dbConnect();
  const token = account.id_token;
  if (!token) {
    throw new Error('ID token is missing');
  }

  const email = user.email!;
  const ticket: LoginTicket = await client.verifyIdToken({
    idToken: token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const user1 = await Users.findOne({ email: email });
  const { accessToken, refreshToken } = await generateTokens(user1);
  return accessToken;
};

// NextAuth configuration options
const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      const { name, email } = user;
      if (account?.provider === 'google') {
        try {
          await dbConnect();
          const userExists = await Users.findOne({ email });
          if (!userExists) {
            const newUser = new Users({ name, email });
            await newUser.save();
            return true;
          }
          return true;
        } catch (error) {
          console.error(error);
          return false;
        }
      }
      return false;
    },
    async jwt({ token, user, account }) {
      const typedToken = token as JWT & {
        accessTokenExpires?: number;
        accessToken: string;
        refreshToken: string;
        idToken: string | undefined;
        accessTokenFromBackend?: string;
      };

      if (account && user) {
        return {
          idToken: account.id_token,
          accessToken: account.access_token,
          accessTokenExpires: account.expires_at ? account.expires_at * 1000 : 0,
          refreshToken: account.refresh_token ?? '',
          accessTokenFromBackend: await gettokenfrombackend(user, account),
          user,
        };
      }

      if (Date.now() < typedToken.accessTokenExpires!) {
        return typedToken;
      }

      return refreshAccessToken(typedToken);
    },

    async session({ session, token }) {
      const typedToken = token as JWT & {
        accessTokenExpires?: number;
        accessToken: string;
        refreshToken: string;
        idToken: string | undefined;
        accessTokenFromBackend?: string;
      };

      session.user = typedToken.user as { name?: string; email?: string; image?: string };
      session.accessToken = typedToken.accessToken;
      session.accessTokenBackend = typedToken.accessTokenFromBackend;
      session.idToken = typedToken.idToken;
      session.error = typedToken.error as string | undefined;

      if (typedToken.accessTokenFromBackend) {
        return session;
      }

      return {
        ...session,
        user: { name: null, email: null, image: null },
        accessToken: null,
        accessTokenBackend: null,
        error: null,
        idToken: null,
      };
    },
  },
};

// Function to refresh the token
async function refreshAccessToken(token: any) {
  try {
    const refreshToken = token.refreshToken;
    if (typeof refreshToken !== 'string') {
      throw new Error('Invalid refresh token');
    }

    const url =
      'https://oauth2.googleapis.com/token?' +
      new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID as string,
        client_secret: process.env.GOOGLE_CLIENT_SECRET as string,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });

    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    });

    const refreshedTokens = await response.json();

    if (!response.ok) {
      throw refreshedTokens;
    }

    return {
      ...token,
      idToken: refreshedTokens.id_token,
      accessToken: refreshedTokens.access_token,
      accessTokenExpires: Date.now() + refreshedTokens.expires_in * 1000,
      refreshToken: refreshedTokens.refresh_token ?? token.refreshToken,
    };
  } catch (error) {
    console.log(error);
    return { ...token, error: 'RefreshAccessTokenError' };
  }
}

// NextAuth handler
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
