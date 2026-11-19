import { relations } from "drizzle-orm";
import {
  tenants,
  users,
  userTenants,
  properties,
  rooms,
  bookings,
  payments,
  icalSources,
  icalBlocks,
  manualBlocks,
  bookingRules,
  pricingRules,
  bookingLines,
} from "./schema";

export const tenantsRelations = relations(tenants, ({ many }) => ({
  userTenants: many(userTenants),
  properties: many(properties),
  rooms: many(rooms),
  bookings: many(bookings),
  manualBlocks: many(manualBlocks),
  bookingRules: many(bookingRules),
  pricingRules: many(pricingRules),
}));

export const usersRelations = relations(users, ({ many }) => ({
  userTenants: many(userTenants),
}));

export const userTenantsRelations = relations(userTenants, ({ one }) => ({
  user: one(users, { fields: [userTenants.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [userTenants.tenantId], references: [tenants.id] }),
}));

export const propertiesRelations = relations(properties, ({ one, many }) => ({
  tenant: one(tenants, { fields: [properties.tenantId], references: [tenants.id] }),
  rooms: many(rooms),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  tenant: one(tenants, { fields: [rooms.tenantId], references: [tenants.id] }),
  property: one(properties, { fields: [rooms.propertyId], references: [properties.id] }),
  bookings: many(bookings),
  icalSources: many(icalSources),
  icalBlocks: many(icalBlocks),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  tenant: one(tenants, { fields: [bookings.tenantId], references: [tenants.id] }),
  lines: many(bookingLines),
  room: one(rooms, { fields: [bookings.roomId], references: [rooms.id] }),
  payment: one(payments, { fields: [bookings.id], references: [payments.bookingId] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  tenant: one(tenants, { fields: [payments.tenantId], references: [tenants.id] }),
  booking: one(bookings, { fields: [payments.bookingId], references: [bookings.id] }),
}));

export const icalSourcesRelations = relations(icalSources, ({ one, many }) => ({
  tenant: one(tenants, { fields: [icalSources.tenantId], references: [tenants.id] }),
  room: one(rooms, { fields: [icalSources.roomId], references: [rooms.id] }),
  blocks: many(icalBlocks),
}));

export const icalBlocksRelations = relations(icalBlocks, ({ one }) => ({
  tenant: one(tenants, { fields: [icalBlocks.tenantId], references: [tenants.id] }),
  room: one(rooms, { fields: [icalBlocks.roomId], references: [rooms.id] }),
  source: one(icalSources, { fields: [icalBlocks.sourceId], references: [icalSources.id] }),
}));

export const manualBlocksRelations = relations(manualBlocks, ({ one }) => ({
  tenant: one(tenants, { fields: [manualBlocks.tenantId], references: [tenants.id] }),
}));

export const bookingRulesRelations = relations(bookingRules, ({ one }) => ({
  tenant: one(tenants, { fields: [bookingRules.tenantId], references: [tenants.id] }),
}));

export const pricingRulesRelations = relations(pricingRules, ({ one }) => ({
  tenant: one(tenants, { fields: [pricingRules.tenantId], references: [tenants.id] }),
}));

export const bookingLinesRelations = relations(bookingLines, ({ one }) => ({
  booking: one(bookings, { fields: [bookingLines.bookingId], references: [bookings.id] }),
}));
