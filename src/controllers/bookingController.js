const Booking = require("../models/Booking");
const Room = require("../models/Room");
const Hotel = require("../models/Hotel");
const Notification = require("../models/Notification");

// 📌 User đặt phòng
exports.createBooking = async (req, res) => {
  try {
    const {
      room_id,
      hotel_id,
      check_in_date,
      check_out_date,
      total_guests,
      total_price,
    } = req.body;
    const user_id = req.user.id; // lấy từ token

    // check room
    const room = await Room.findById(room_id);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (!room.is_available)
      return res.status(400).json({ message: "Room is not available" });

    // tạo booking
    const booking = new Booking({
      user_id,
      room_id,
      hotel_id,
      check_in_date,
      check_out_date,
      total_guests,
      total_price,
      status: "pending",
    });

    await booking.save();

    // giữ phòng
    room.is_available = false;
    await room.save();

    // Lấy hotel để gửi thông báo cho owner
    const hotel = await Hotel.findById(hotel_id);
    if (hotel) {
      const notification = await Notification.create({
        user_id: hotel.owner_id,
        title: "New Booking Request",
        message: `You have a new booking request for hotel "${hotel.name}".`,
      });

      // Gửi realtime notification (Socket.IO)
      const io = req.app.get("io");
      if (io) {
        io.to(String(hotel.owner_id._id)).emit("notification:new", {
          notification: {
            _id: notification._id,
            title: notification.title,
            message: notification.message,
            created_at: notification.created_at || new Date().toISOString(),
            type: "review:created",
          },
        });
      }
    }

    res.status(201).json({ message: "Booking created successfully", booking });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error creating booking", error: error.message });
  }
};

// 📌 Hủy phòng (user hoặc admin)
exports.cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;

    const booking = await Booking.findById(id).populate("hotel_id");
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    // chỉ cho chủ booking hoặc admin hủy
    if (
      req.user.role !== "admin" &&
      booking.user_id.toString() !== req.user.id
    ) {
      return res
        .status(403)
        .json({ message: "Not authorized to cancel this booking" });
    }

    booking.status = "cancelled";
    await booking.save();

    // mở lại phòng
    const room = await Room.findById(booking.room_id);
    if (room) {
      room.is_available = true;
      await room.save();
    }

    // Gửi thông báo cho chủ khách sạn
    const hotel = await Hotel.findById(booking.hotel_id);
    if (hotel) {
      const notification = await Notification.create({
        user_id: hotel.owner_id,
        title: "Booking Cancelled",
        message: `A booking for hotel "${hotel.name}" has been cancelled.`,
      });
      const io = req.app.get("io");
      if (io) {
        io.to(String(hotel.owner_id)).emit("notification:new", {
          notification: {
            _id: notification._id,
            title: notification.title,
            message: notification.message,
            created_at: notification.created_at || new Date().toISOString(),
            type: "booking:cancelled",
          },
        });
      }
    }

    res.json({ message: "Booking cancelled successfully", booking });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error cancelling booking", error: error.message });
  }
};

// 📌 Chủ khách sạn xác nhận / từ chối booking
exports.updateBookingStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // confirmed | cancelled

    if (!["confirmed", "cancelled"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const booking = await Booking.findById(id).populate("hotel_id");
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    // chỉ cho chủ khách sạn của booking hoặc admin
    if (
      req.user.role !== "admin" &&
      booking.hotel_id.owner_id.toString() !== req.user.id
    ) {
      return res
        .status(403)
        .json({ message: "Not authorized to update this booking status" });
    }

    booking.status = status;
    await booking.save();

    // nếu chủ từ chối thì mở lại phòng
    if (status === "cancelled") {
      const room = await Room.findById(booking.room_id);
      if (room) {
        room.is_available = true;
        await room.save();
      }
    }

    // Gửi thông báo cho user
    const notification = await Notification.create({
      user_id: booking.user_id,
      title: `Booking ${status}`,
      message: `Your booking at hotel "${booking.hotel_id.name}" has been ${status}.`,
    });

    const io = req.app.get("io");
    if (io) {
      io.to(String(booking.user_id)).emit("notification:new", {
        notification: {
          _id: notification._id,
          title: notification.title,
          message: notification.message,
          created_at: notification.created_at || new Date().toISOString(),
          type: `booking:${status}`,
        },
      });
    }

    res.json({ message: `Booking ${status} successfully`, booking });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating booking status", error: error.message });
  }
};

//  User: lấy booking của chính mình
exports.getUserBookings = async (req, res) => {
  try {
    const user_id = req.user.id;
    const bookings = await Booking.find({ user_id })
      .populate("hotel_id", "name city")
      .populate("room_id", "room_number"); // Populate các thông tin cần thiết

    res.json({ bookings });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching user bookings", error: error.message });
  }
};

//  Owner: lấy booking theo khách sạn mà mình sở hữu
exports.getOwnerBookings = async (req, res) => {
  try {
    const owner_id = req.user.id;
    // 1. Tìm tất cả Hotel mà user là owner
    const hotels = await Hotel.find({ owner_id: owner_id }).select("_id");
    const hotelIds = hotels.map((hotel) => hotel._id);

    // 2. Tìm tất cả Bookings thuộc các Hotel này
    const bookings = await Booking.find({ hotel_id: { $in: hotelIds } })
      .populate("hotel_id", "name city")
      .populate("room_id", "room_number")
      .populate("user_id", "email username"); // Thông tin user đặt

    res.json({ bookings });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching owner bookings", error: error.message });
  }
};

//  Admin: lấy tất cả bookings
exports.getAllBookings = async (req, res) => {
  try {
    // Chỉ cho phép admin truy cập
    if (req.user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Access denied. Admin role required." });
    }

    const bookings = await Booking.find({})
      .populate("hotel_id", "name city")
      .populate("room_id", "room_number")
      .populate("user_id", "email username");

    res.json({ bookings });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching all bookings", error: error.message });
  }
};
