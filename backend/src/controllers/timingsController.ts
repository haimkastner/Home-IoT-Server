import { Body, Controller, Delete, Get, Header, Path, Post, Put, Query, Response, Route, Security, SuccessResponse, Tags } from 'tsoa';
import { TimingsBlSingleton } from '../business-layer/timingsBl';
import { ErrorResponse, Timing } from '../models/sharedInterfaces';

@Tags('Timings')
@Route('timings')
export class TimingsController extends Controller {

    /**
     * Get all the timings in the system.
     * @returns Timings array.
     */
    @Security('userAuth')
    @Security('adminAuth')
    @Response<ErrorResponse>(501, 'Server error')
    @Get()
    public async getTimings(): Promise<Timing[]> {
        return await TimingsBlSingleton.getTimings();
    }

    /**
     * Get timing by id.
     * @returns Timing.
     */
    @Security('userAuth')
    @Security('adminAuth')
    @Response<ErrorResponse>(501, 'Server error')
    @Get('{timingId}')
    public async getTiming(timingId: string): Promise<Timing> {
        return await TimingsBlSingleton.getTimingById(timingId);
    }

    /**
     * Update timing properties.
     * @param timingId Timing id.
     * @param timing Timing object to update to.
     */
    @Security('userAuth')
    @Security('adminAuth')
    @Response<ErrorResponse>(501, 'Server error')
    @Put('{timingId}')
    public async setTiming(timingId: string, @Body() timing: Timing): Promise<void> {
        return await TimingsBlSingleton.SetTiming(timingId, timing);
    }

    /**
     * Delete timing from the system.
     * @param timingId Timing id.
     */
    @Security('userAuth')
    @Security('adminAuth')
    @Response<ErrorResponse>(501, 'Server error')
    @Delete('{timingId}')
    public async deleteTiming(timingId: string): Promise<void> {
        return await TimingsBlSingleton.DeleteTiming(timingId);
    }

    /**
     *  Creates a new timing.
     * @param timing The new timing to create.
     */
    @Security('userAuth')
    @Security('adminAuth')
    @Response<ErrorResponse>(501, 'Server error')
    @Post()
    public async createTiming(@Body() timing: Timing): Promise<void> {
        return await TimingsBlSingleton.CreateTiming(timing);
    }

}
